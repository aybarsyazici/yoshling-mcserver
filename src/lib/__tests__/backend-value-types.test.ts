import { describe, expect, it } from "vitest";
import { errorCode, errorMessage } from "@/lib/error-details";
import { gameVersionTags, categoryTags } from "@/lib/modrinth-tags";

describe("typed unknown error details", () => {
  it("keeps actual Node errors and plain library error objects intact", () => {
    const error = Object.assign(new Error("fixture read failure"), { code: "EIO" });
    expect(errorCode(error)).toBe("EIO");
    expect(errorMessage(error)).toBe("fixture read failure");
    expect(errorCode({ code: "ENOENT" })).toBe("ENOENT");
    expect(errorMessage({ message: "fixture game error" })).toBe("fixture game error");
  });
  it("does not treat malformed fields or primitives as error metadata", () => {
    for (const error of [null, undefined, "failure", 42, { code: 42, message: [] }]) {
      expect(errorCode(error)).toBeUndefined();
      expect(errorMessage(error)).toBeUndefined();
    }
  });
});

describe("typed Modrinth tag payloads", () => {
  it("preserves complete valid arrays including optional/null category icons", () => {
    const versions = [{ version: "1.21.4", version_type: "release" }];
    const categories = [{ name: "technology", project_type: "mod", icon: null }, { name: "magic", project_type: "mod" }];
    expect(gameVersionTags(versions)).toBe(versions);
    expect(categoryTags(categories)).toBe(categories);
  });
  it("refuses malformed upstream arrays instead of presenting truncated or wrongly typed options", () => {
    for (const data of [null, {}, [null], [{ version: 42, version_type: "release" }]]) expect(gameVersionTags(data)).toBeNull();
    for (const data of [null, {}, [null], [{ name: 42, project_type: "mod" }], [{ name: "mod", project_type: "mod", icon: {} }]]) expect(categoryTags(data)).toBeNull();
  });
});
