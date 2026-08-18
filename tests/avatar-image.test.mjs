import test from "node:test";
import assert from "node:assert/strict";

import { AVATAR_MAX_DIMENSION, fittedAvatarSize } from "../js/features/cloud/avatar-image.js";

test("el avatar conserva proporciones y no supera la dimensión máxima", () => {
    assert.deepEqual(fittedAvatarSize(4000, 2000), { width: AVATAR_MAX_DIMENSION, height: 512 });
    assert.deepEqual(fittedAvatarSize(600, 800), { width: 600, height: 800 });
    assert.deepEqual(fittedAvatarSize(100, 4000), { width: 26, height: AVATAR_MAX_DIMENSION });
});
