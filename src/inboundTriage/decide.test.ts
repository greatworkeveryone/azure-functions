import { AUTO_MIN_MARGIN, AUTO_MIN_SCORE, decide } from "./decide";
import { rulesRanker } from "./rulesRanker";
import { candidate, context } from "../__tests__/fixtures/inboundTriageBuilders";
import type { LinkedSend, ScoredCandidate } from "./types";

const scored = (userId: number, score: number): ScoredCandidate => ({ ...candidate(userId, `User ${userId}`), reasons: [], score });
const send = (sentByUserId: number | null, recipientEmail: string | null = "tenant@acme.example"): LinkedSend => ({ buildingId: null, jobId: null, kind: "broadcast", recipientEmail, sendId: "s1", sentByUserId, subject: "Water shut-off", tenancyId: null });

describe("decide", () => {
  it("queues an email nobody can be given", () => {
    expect(decide([], context())).toEqual({ decision: "queued", rule: "no_candidates" });
  });

  it("assigns a reply to the person who sent the send, when they are among the candidates, whatever the scores", () => {
    const verdict = decide([scored(1, 90), scored(2, 5)], context({ linkedSend: send(2), replyVerified: true }));
    expect(verdict).toMatchObject({ decision: "auto", rule: "reply_to_known_send", chosen: { userId: 2 } });
  });

  it("does not follow the send when its sender is not a candidate (away or inactive)", () => {
    const verdict = decide([scored(1, 15), scored(2, 14)], context({ linkedSend: send(9) }));
    expect(verdict).toEqual({ decision: "queued", rule: "weak_match" });
  });

  it("does not follow a send with no sender", () => {
    expect(decide([scored(1, 15)], context({ linkedSend: send(null) })).decision).toBe("queued");
  });

  it("assigns a clear leader: at the threshold, ahead of the next by the margin", () => {
    expect(decide([scored(1, AUTO_MIN_SCORE), scored(2, AUTO_MIN_SCORE - AUTO_MIN_MARGIN)], context())).toMatchObject({ decision: "auto", rule: "clear_leader", chosen: { userId: 1 } });
  });

  it("queues a leader under the threshold, or without the margin", () => {
    expect(decide([scored(1, AUTO_MIN_SCORE - 1), scored(2, 0)], context()).decision).toBe("queued");
    expect(decide([scored(1, 80), scored(2, 80 - AUTO_MIN_MARGIN + 1)], context()).decision).toBe("queued");
  });

  it("assigns a lone candidate who clears the threshold, and queues a lone candidate who does not", () => {
    expect(decide([scored(1, AUTO_MIN_SCORE)], context()).decision).toBe("auto");
    expect(decide([scored(1, 15)], context()).decision).toBe("queued");
  });

  it("with the rules ranker, a reply's sender wins and a role alone never assigns", () => {
    const ctx = context({ linkedSend: send(2), replyVerified: true });
    const ranked = rulesRanker.rank([candidate(1, "Fay"), candidate(2, "Gus", { sentLinkedSend: true })], ctx);
    expect(decide(ranked, ctx)).toMatchObject({ decision: "auto", chosen: { userId: 2 } });
    expect(decide(rulesRanker.rank([candidate(1, "Fay"), candidate(2, "Gus")], context()), context()).decision).toBe("queued");
  });

  describe("a sender who could not be verified", () => {
    it("is always queued, whatever the scores and the reply link say", () => {
      const ctx = context({ linkedSend: send(2), replyVerified: false, senderVerified: false });
      expect(decide([scored(2, 90), scored(1, 5)], ctx)).toEqual({ decision: "queued", rule: "sender_unverified" });
      expect(decide([scored(1, 90)], context({ senderVerified: false }))).toEqual({ decision: "queued", rule: "sender_unverified" });
      expect(decide([], context({ senderVerified: false }))).toEqual({ decision: "queued", rule: "sender_unverified" });
    });
  });

  describe("an assignment that rests on a reply link", () => {
    it("needs the email to come from the address the send went to, as well as a verified sender", () => {
      const ctx = context({ linkedSend: send(2), replyVerified: false });
      expect(decide([scored(2, 90), scored(1, 5)], ctx)).toEqual({ decision: "queued", rule: "reply_unverified" });
    });

    it("also holds back a leader whose lead is the reply link, when the reply is not verified", () => {
      const lead = { ...scored(2, 75), features: { ...candidate(2, "x").features, sentLinkedSend: true } };
      expect(decide([lead, scored(1, 15)], context({ linkedSend: send(2), replyVerified: false }))).toEqual({ decision: "queued", rule: "reply_unverified" });
      expect(decide([lead, scored(1, 15)], context({ linkedSend: send(2), replyVerified: true }))).toMatchObject({ decision: "auto" });
    });

    it("leaves a leader whose lead has nothing to do with a reply alone", () => {
      expect(decide([scored(1, 80), scored(2, 5)], context({ linkedSend: send(9), replyVerified: false }))).toMatchObject({ decision: "auto", rule: "clear_leader" });
    });
  });
});
