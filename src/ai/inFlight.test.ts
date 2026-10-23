/// <reference types="jest" />
import { inFlightFor, MAX_IN_FLIGHT_PER_PERSON, personKey, takeSlot } from "./inFlight";
import type { AiActor } from "./types";

const jo: AiActor = { email: "Jo@Randazzo.example", kind: "user", name: "Jo Bloggs", role: "facilities", userId: 41 };
const ada: AiActor = { email: "ada@randazzo.example", kind: "user", name: "Ada Lovelace", role: "director", userId: 7 };

describe("who a call belongs to", () => {
  it("is a person by their AppUsers id, else their email in lower case, else the system process's name", () => {
    expect(personKey(jo)).toBe("id:41");
    expect(personKey({ ...jo, userId: null })).toBe("email:jo@randazzo.example");
    expect(personKey({ email: null, kind: "system", name: "digestTimer", role: null, userId: null })).toBe("name:system:digestTimer");
    expect(personKey({ email: null, kind: "user", name: "Someone", role: null, userId: null })).toBe("name:user:Someone");
  });

  it("keeps two people apart even when one's id is another's name", () => {
    expect(personKey({ ...jo, userId: 7 })).not.toBe(personKey({ email: null, kind: "user", name: "7", role: null, userId: null }));
  });
});

describe("two calls in flight per person", () => {
  it("allows two, turns the third away, and lets another person in meanwhile", () => {
    expect(MAX_IN_FLIGHT_PER_PERSON).toBe(2);
    const first = takeSlot(jo);
    const second = takeSlot(jo);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(takeSlot(jo)).toBeNull();
    expect(inFlightFor(jo)).toBe(2);
    const other = takeSlot(ada);
    expect(other).not.toBeNull();
    first?.();
    second?.();
    other?.();
  });

  it("gives a slot back, once: a second release changes nothing", () => {
    const first = takeSlot(jo);
    const second = takeSlot(jo);
    first?.();
    first?.();
    first?.();
    expect(inFlightFor(jo)).toBe(1);
    const third = takeSlot(jo);
    expect(third).not.toBeNull();
    expect(takeSlot(jo)).toBeNull();
    second?.();
    third?.();
    expect(inFlightFor(jo)).toBe(0);
  });

  it("counts the same person the same way whichever way they are named", () => {
    const first = takeSlot(jo);
    const second = takeSlot({ ...jo, email: "other@x.example", name: "Another Name" });
    expect(takeSlot(jo)).toBeNull();
    first?.();
    second?.();
  });

  it("forgets a person with nothing in flight, so the map cannot grow", () => {
    const slot = takeSlot(ada);
    slot?.();
    expect(inFlightFor(ada)).toBe(0);
  });
});
