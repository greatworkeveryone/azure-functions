// Facilities rules (LAUNCH-READINESS §5, WP47/WP48, WP50): pure, no I/O.
// Mirrored byte for byte in command-centre src/helpers/facilitiesRules/ and
// rpcc-functions src/facilitiesRules/, pinned on both sides by the same vector
// file (facilities-rules.vectors.json). Change both copies and the vectors
// together. Dates are Darwin calendar dates as "YYYY-MM-DD" strings, so no
// time zone can shift a day.

export * from "./dates";
export * from "./defects";
export * from "./schedules";
