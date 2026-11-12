import assert from 'node:assert/strict';
import { InteractivePoll } from '../src/interactive-poll.ts';
let now = 0;
const poll = new InteractivePoll(() => now);
assert.equal(poll.delay(true), 150);
const sleeping = poll.wait(true);
poll.activity();
await sleeping; // Input wakes the existing awaited sleep, not another poll.
assert.equal(poll.delay(true), 12);
assert.equal(poll.delay(false), 150);
now = 1199;
assert.equal(poll.delay(true), 12);
poll.activity();
now = 1201;
assert.equal(poll.delay(true), 12);
now = 2400;
assert.equal(poll.delay(true), 150);
await poll.wait(true); // Timed idle wait also clears its wake callback.
poll.activity();
console.log('PASS interactive polling: immediate wake, bounded activity window, background/idle backoff');
