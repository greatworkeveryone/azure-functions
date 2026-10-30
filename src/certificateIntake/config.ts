// Certificate intake (TR8): the one setting. The "received, thanks" reply to a contractor is off unless
// CERTIFICATE_ACK_ENABLED is exactly "true"; when on it still goes through the send core, so COMMS_SEND_ENABLED,
// COMMS_SEND_DRY_RUN, DEV_EMAIL_OVERRIDE and the test-record egress guard all apply as for any send.

export const ACK_TEMPLATE_SLUG = "certificate-received";
export const ACK_TEMPLATE_ID = "certificate_received";

export const acknowledgementEnabled = (): boolean => process.env.CERTIFICATE_ACK_ENABLED === "true";
