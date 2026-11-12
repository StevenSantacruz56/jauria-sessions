import assert from 'node:assert/strict';
import { validateSequence } from '../src/events.ts';
validateSequence(0,{seq:1,kind:'output',data:'text'});
validateSequence(2,{seq:6,kind:'purged',data:JSON.stringify({firstSeq:3,lastSeq:6})});
validateSequence(4,{seq:6,kind:'purged',data:JSON.stringify({firstSeq:3,lastSeq:6})});
validateSequence(5,{seq:6,kind:'purged',data:JSON.stringify({firstSeq:3,lastSeq:6})});
for (const event of [
  {seq:6,kind:'output',data:''},
  {seq:6,kind:'purged',data:JSON.stringify({firstSeq:4,lastSeq:6})},
  {seq:6,kind:'purged',data:JSON.stringify({firstSeq:3,lastSeq:5})},
  {seq:6,kind:'purged',data:JSON.stringify({firstSeq:-1,lastSeq:6})},
  {seq:6,kind:'purged',data:'{}'},
  {seq:2,kind:'purged',data:JSON.stringify({firstSeq:1,lastSeq:2})},
  {seq:Number.MAX_SAFE_INTEGER+1,kind:'purged',data:'{}'},
]) assert.throws(()=>validateSequence(2,event));
console.log('Event continuity: contiguous output, purge coverage and malformed/missing ranges passed.');
