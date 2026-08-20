import { describe, expect, it } from "vitest";
import {
  SessionRowSchema,
  SessionsCreateResultSchema,
  validateSessionsCreateParams,
} from "../index.js";

describe("sessions.create schema", () => {
  it.each(["read-only", "guarded", "workspace", "full"])(
    "accepts the closed permission mode %s",
    (permissionMode) => {
      expect(validateSessionsCreateParams({ agentId: "main", permissionMode })).toBe(true);
    },
  );

  it("rejects unknown permission modes", () => {
    expect(validateSessionsCreateParams({ agentId: "main", permissionMode: "unrestricted" })).toBe(
      false,
    );
  });

  it("accepts additive create-time visibility values", () => {
    for (const visibility of ["shared", "read-only", "suggest", "draft"]) {
      expect(validateSessionsCreateParams({ agentId: "main", visibility })).toBe(true);
    }
  });

  it("rejects unknown visibility values", () => {
    expect(validateSessionsCreateParams({ agentId: "main", visibility: "private" })).toBe(false);
  });

  it("declares model-control fields on the canonical session row", () => {
    expect(SessionRowSchema.properties).toMatchObject({
      thinkingLevel: expect.any(Object),
      thinkingLevels: expect.any(Object),
      thinkingOptions: expect.any(Object),
      thinkingDefault: expect.any(Object),
    });
    expect(SessionsCreateResultSchema.properties.session).toBeDefined();
  });
});
