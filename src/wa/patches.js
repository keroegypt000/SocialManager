// Runtime fix for Cloudflare's Node.js Buffer: buf.utf8Write(str, offset) without a
// length uses the whole buffer length instead of (length - offset), so writing at
// any offset > 0 throws "length is out of range". protobufjs (used by Baileys) writes
// every string of 40+ characters this way, so long captions failed.
// Node's behaviour: the default length is what's left after the offset.
const ENCODINGS = ['utf8Write', 'latin1Write', 'asciiWrite', 'ucs2Write', 'hexWrite', 'base64Write'];

for (const name of ENCODINGS) {
  const orig = Buffer.prototype[name];
  if (typeof orig !== 'function' || orig.__fixed) continue;
  const fixed = function (string, offset = 0, length) {
    const room = this.length - offset;
    return orig.call(this, string, offset, length === undefined ? room : Math.min(length, room));
  };
  fixed.__fixed = true;
  Buffer.prototype[name] = fixed;
}
