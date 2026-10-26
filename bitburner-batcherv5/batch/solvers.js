/**
 * Coding contract solvers, one per contract type in Bitburner 3.0.x.
 * Each takes the contract's data and returns the answer in the type the game
 * expects (number, string or array). Tested against the game's own contract
 * generators and answer checkers.
 */

// ------------------------------------------------------------ number theory --

function largestPrimeFactor(n) {
  let f = 2;
  let last = 1;
  while (f * f <= n) {
    if (n % f === 0) {
      last = f;
      n /= f;
    } else f += f === 2 ? 1 : 2;
  }
  return n > 1 ? n : last;
}

function totalPrimesInRange([low, high]) {
  low = Math.max(2, low);
  if (high < low) return 0;
  const limit = Math.floor(Math.sqrt(high));
  const small = new Uint8Array(limit + 1);
  const primes = [];
  for (let i = 2; i <= limit; i++) {
    if (!small[i]) {
      primes.push(i);
      for (let j = i * i; j <= limit; j += i) small[j] = 1;
    }
  }
  const comp = new Uint8Array(high - low + 1);
  for (const p of primes) {
    let start = Math.max(p * p, Math.ceil(low / p) * p);
    for (let j = start; j <= high; j += p) comp[j - low] = 1;
  }
  let count = 0;
  for (let i = 0; i < comp.length; i++) if (!comp[i]) count++;
  return count;
}

function squareRoot(n) {
  n = BigInt(n);
  if (n < 2n) return n;
  // Newton's method for floor(sqrt(n)), then round to nearest.
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  if (x === 0n) x = 1n;
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x && y - x <= 1n) {
      x = y;
      break;
    }
    if (y === x) break;
    x = y;
  }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  // Nearest integer: x or x+1, whichever square is closer.
  return n - x * x <= (x + 1n) * (x + 1n) - n ? x : x + 1n;
}

function totalWaysToSum(n) {
  // Partitions of n into at least two positive parts.
  const ways = new Array(n + 1).fill(0);
  ways[0] = 1;
  for (let part = 1; part < n; part++) for (let i = part; i <= n; i++) ways[i] += ways[i - part];
  return ways[n];
}

function totalWaysToSumII([n, parts]) {
  const ways = new Array(n + 1).fill(0);
  ways[0] = 1;
  for (const part of parts) for (let i = part; i <= n; i++) ways[i] += ways[i - part];
  return ways[n];
}

// ------------------------------------------------------------------ arrays --

function subarrayMaxSum(arr) {
  let best = -Infinity;
  let cur = 0;
  for (const x of arr) {
    cur = Math.max(x, cur + x);
    best = Math.max(best, cur);
  }
  return best;
}

function spiralize(m) {
  const out = [];
  if (m.length === 0) return out;
  let top = 0;
  let bottom = m.length - 1;
  let left = 0;
  let right = m[0].length - 1;
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c++) out.push(m[top][c]);
    top++;
    for (let r = top; r <= bottom; r++) out.push(m[r][right]);
    right--;
    if (top <= bottom) {
      for (let c = right; c >= left; c--) out.push(m[bottom][c]);
      bottom--;
    }
    if (left <= right) {
      for (let r = bottom; r >= top; r--) out.push(m[r][left]);
      left++;
    }
  }
  return out;
}

function arrayJumping(arr) {
  let reach = 0;
  for (let i = 0; i < arr.length && i <= reach; i++) reach = Math.max(reach, i + arr[i]);
  return reach >= arr.length - 1 ? 1 : 0;
}

function arrayJumpingII(arr) {
  if (arr.length <= 1) return 0;
  let jumps = 0;
  let end = 0;
  let far = 0;
  for (let i = 0; i < arr.length - 1; i++) {
    far = Math.max(far, i + arr[i]);
    if (i === end) {
      if (far <= i) return 0; // can't get past here
      jumps++;
      end = far;
      if (end >= arr.length - 1) return jumps;
    }
  }
  return end >= arr.length - 1 ? jumps : 0;
}

function mergeIntervals(intervals) {
  const sorted = intervals.map((x) => [...x]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    if (out.length && iv[0] <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], iv[1]);
    else out.push(iv);
  }
  return out;
}

function triangleMinPath(tri) {
  const dp = [...tri[tri.length - 1]];
  for (let r = tri.length - 2; r >= 0; r--) for (let c = 0; c <= r; c++) dp[c] = tri[r][c] + Math.min(dp[c], dp[c + 1]);
  return dp[0];
}

// ------------------------------------------------------------------ stocks --

function stockK(k, prices) {
  const n = prices.length;
  if (n < 2 || k <= 0) return 0;
  if (k >= n / 2) {
    let p = 0;
    for (let i = 1; i < n; i++) p += Math.max(0, prices[i] - prices[i - 1]);
    return p;
  }
  const buy = new Array(k + 1).fill(-Infinity);
  const sell = new Array(k + 1).fill(0);
  for (const price of prices) {
    for (let t = k; t >= 1; t--) {
      sell[t] = Math.max(sell[t], buy[t] + price);
      buy[t] = Math.max(buy[t], sell[t - 1] - price);
    }
  }
  return sell[k];
}

// ------------------------------------------------------------------- grids --

function uniquePathsI([rows, cols]) {
  // C(rows+cols-2, rows-1), computed exactly.
  let r = 1;
  const a = rows - 1;
  const b = cols - 1;
  for (let i = 1; i <= Math.min(a, b); i++) r = (r * (a + b - i + 1)) / i;
  return Math.round(r);
}

function uniquePathsII(grid) {
  const cols = grid[0].length;
  const dp = new Array(cols).fill(0);
  dp[0] = grid[0][0] === 0 ? 1 : 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === 1) dp[c] = 0;
      else if (c > 0) dp[c] += dp[c - 1];
    }
  }
  return dp[cols - 1];
}

function shortestPath(grid) {
  const h = grid.length;
  const w = grid[0].length;
  if (grid[0][0] === 1 || grid[h - 1][w - 1] === 1) return "";
  const prev = Array.from({ length: h }, () => new Array(w).fill(null));
  prev[0][0] = "";
  const q = [[0, 0]];
  const moves = [
    [-1, 0, "U"],
    [1, 0, "D"],
    [0, -1, "L"],
    [0, 1, "R"],
  ];
  for (let qi = 0; qi < q.length; qi++) {
    const [y, x] = q[qi];
    if (y === h - 1 && x === w - 1) break;
    for (const [dy, dx, ch] of moves) {
      const ny = y + dy;
      const nx = x + dx;
      if (ny < 0 || nx < 0 || ny >= h || nx >= w || grid[ny][nx] === 1 || prev[ny][nx] !== null) continue;
      prev[ny][nx] = [y, x, ch];
      q.push([ny, nx]);
    }
  }
  if (prev[h - 1][w - 1] === null) return "";
  let path = "";
  let y = h - 1;
  let x = w - 1;
  while (!(y === 0 && x === 0)) {
    const [py, px, ch] = prev[y][x];
    path = ch + path;
    y = py;
    x = px;
  }
  return path;
}

function largestRectangle(m) {
  // Largest all-zero rectangle: histogram method per row.
  const rows = m.length;
  const cols = m[0].length;
  const height = new Array(cols).fill(0);
  let best = { area: 0, r1: 0, c1: 0, r2: 0, c2: 0 };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) height[c] = m[r][c] === 0 ? height[c] + 1 : 0;
    const stack = [];
    for (let c = 0; c <= cols; c++) {
      const hgt = c === cols ? 0 : height[c];
      let start = c;
      while (stack.length && stack[stack.length - 1][1] >= hgt) {
        const [s, sh] = stack.pop();
        const area = sh * (c - s);
        if (area > best.area) best = { area, r1: r - sh + 1, c1: s, r2: r, c2: c - 1 };
        start = s;
      }
      stack.push([start, hgt]);
    }
  }
  return [
    [best.r1, best.c1],
    [best.r2, best.c2],
  ];
}

// ----------------------------------------------------------------- strings --

function generateIPs(s) {
  const out = [];
  const ok = (p) => p.length > 0 && p.length <= 3 && (p === "0" || p[0] !== "0") && Number(p) <= 255;
  for (let a = 1; a <= 3; a++)
    for (let b = 1; b <= 3; b++)
      for (let c = 1; c <= 3; c++) {
        const d = s.length - a - b - c;
        if (d < 1 || d > 3) continue;
        const parts = [s.slice(0, a), s.slice(a, a + b), s.slice(a + b, a + b + c), s.slice(a + b + c)];
        if (parts.every(ok)) out.push(parts.join("."));
      }
  return out;
}

function sanitizeParens(s) {
  const valid = (t) => {
    let bal = 0;
    for (const ch of t) {
      if (ch === "(") bal++;
      else if (ch === ")" && --bal < 0) return false;
    }
    return bal === 0;
  };
  let level = new Set([s]);
  for (;;) {
    const good = [...level].filter(valid);
    if (good.length) return good;
    const next = new Set();
    for (const t of level) {
      for (let i = 0; i < t.length; i++) {
        if (t[i] === "(" || t[i] === ")") next.add(t.slice(0, i) + t.slice(i + 1));
      }
    }
    if (next.size === 0) return [""];
    level = next;
  }
}

/**
 * Every way to put + - * between the digits to reach the target. This can
 * search hundreds of thousands of expressions, so it's a generator that
 * yields now and then: the runner gives it a few ms at a time, so it never
 * holds up the batcher's timing.
 */
function* mathExpressions([digits, target]) {
  const out = [];
  // Explicit stack instead of recursion, so the search can pause anywhere.
  const stack = [[0, "", 0, 0]];
  let steps = 0;
  while (stack.length) {
    const [pos, expr, value, last] = stack.pop();
    if (pos === digits.length) {
      if (value === target) out.push(expr);
      continue;
    }
    for (let end = digits.length; end > pos; end--) {
      const part = digits.slice(pos, end);
      if (part.length > 1 && part[0] === "0") continue;
      const n = Number(part);
      if (pos === 0) stack.push([end, part, n, n]);
      else {
        stack.push([end, `${expr}*${part}`, value - last + last * n, last * n]);
        stack.push([end, `${expr}-${part}`, value - n, -n]);
        stack.push([end, `${expr}+${part}`, value + n, n]);
      }
    }
    if (++steps % 500 === 0) yield;
  }
  return out;
}

/** Run a solver to completion (generators straight through). For tests. */
export function solveNow(type, data) {
  const r = SOLVERS[type](data);
  if (r && typeof r.next === "function") {
    for (;;) {
      const s = r.next();
      if (s.done) return s.value;
    }
  }
  return r;
}

function rle(s) {
  let out = "";
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j < s.length && s[j] === s[i] && j - i < 9) j++;
    out += String(j - i) + s[i];
    i = j;
  }
  return out;
}

function lzDecompress(s) {
  let out = "";
  let literal = true;
  for (let i = 0; i < s.length; ) {
    const len = Number(s[i]);
    if (literal) {
      out += s.slice(i + 1, i + 1 + len);
      i += 1 + len;
    } else if (len === 0) {
      i += 1;
    } else {
      const off = Number(s[i + 1]);
      for (let k = 0; k < len; k++) out += out[out.length - off];
      i += 2;
    }
    literal = !literal;
  }
  return out;
}

/** Shortest LZ encoding, by dynamic programming over (chunk type, offset, length). */
function lzCompress(plain) {
  let cur = Array.from({ length: 10 }, () => new Array(10).fill(null));
  let nxt = Array.from({ length: 10 }, () => new Array(10).fill(null));
  const set = (st, i, j, str) => {
    if (st[i][j] === null || str.length < st[i][j].length) st[i][j] = str;
  };
  cur[0][1] = "";
  for (let i = 1; i < plain.length; i++) {
    for (const row of nxt) row.fill(null);
    const c = plain[i];
    for (let len = 1; len <= 9; len++) {
      const s = cur[0][len];
      if (s === null) continue;
      if (len < 9) set(nxt, 0, len + 1, s);
      else set(nxt, 0, 1, s + "9" + plain.substring(i - 9, i) + "0");
      for (let off = 1; off <= Math.min(9, i); off++) {
        if (plain[i - off] === c) set(nxt, off, 1, s + String(len) + plain.substring(i - len, i));
      }
    }
    for (let off = 1; off <= 9; off++) {
      for (let len = 1; len <= 9; len++) {
        const s = cur[off][len];
        if (s === null) continue;
        if (plain[i - off] === c) {
          if (len < 9) set(nxt, off, len + 1, s);
          else set(nxt, off, 1, s + "9" + String(off) + "0");
        }
        set(nxt, 0, 1, s + String(len) + String(off));
        for (let noff = 1; noff <= Math.min(9, i); noff++) {
          if (plain[i - noff] === c) set(nxt, noff, 1, s + String(len) + String(off) + "0");
        }
      }
    }
    [cur, nxt] = [nxt, cur];
  }
  let best = null;
  for (let len = 1; len <= 9; len++) {
    const s = cur[0][len];
    if (s === null) continue;
    const r = s + String(len) + plain.substring(plain.length - len);
    if (best === null || r.length < best.length) best = r;
  }
  for (let off = 1; off <= 9; off++)
    for (let len = 1; len <= 9; len++) {
      const s = cur[off][len];
      if (s === null) continue;
      const r = s + String(len) + String(off);
      if (best === null || r.length < best.length) best = r;
    }
  return best ?? "";
}

function caesar([text, shift]) {
  return [...text]
    .map((ch) => (ch >= "A" && ch <= "Z" ? String.fromCharCode(((ch.charCodeAt(0) - 65 - shift + 26 * 100) % 26) + 65) : ch))
    .join("");
}

function vigenere([text, key]) {
  return [...text]
    .map((ch, i) => String.fromCharCode(((ch.charCodeAt(0) - 65 + key.charCodeAt(i % key.length) - 65) % 26) + 65))
    .join("");
}

// ---------------------------------------------------------------- hamming --

function hammingEncode(n) {
  const data = n.toString(2).split("").map(Number);
  // Smallest number of parity bits p with 2^p >= data + p + 1.
  let p = 0;
  while (2 ** p < data.length + p + 1) p++;
  const len = data.length + p + 1;
  const bits = new Array(len).fill(0);
  let d = 0;
  for (let i = 1; i < len; i++) if ((i & (i - 1)) !== 0) bits[i] = data[d++];
  for (let k = 0; k < p; k++) {
    const pos = 1 << k;
    let x = 0;
    for (let i = 1; i < len; i++) if (i & pos && i !== pos) x ^= bits[i];
    bits[pos] = x;
  }
  bits[0] = bits.reduce((a, b) => a ^ b, 0);
  return bits.join("");
}

function hammingDecode(s) {
  const bits = s.split("").map(Number);
  let syndrome = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i]) syndrome ^= i;
  if (syndrome) bits[syndrome] ^= 1;
  let data = "";
  for (let i = 1; i < bits.length; i++) if ((i & (i - 1)) !== 0) data += bits[i];
  return parseInt(data, 2);
}

// ------------------------------------------------------------------ graphs --

function twoColoring([n, edges]) {
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const color = new Array(n).fill(-1);
  for (let s = 0; s < n; s++) {
    if (color[s] !== -1) continue;
    color[s] = 0;
    const q = [s];
    for (let qi = 0; qi < q.length; qi++) {
      const v = q[qi];
      for (const u of adj[v]) {
        if (color[u] === -1) {
          color[u] = 1 - color[v];
          q.push(u);
        } else if (color[u] === color[v]) return [];
      }
    }
  }
  return color;
}

export const SOLVERS = {
  "Find Largest Prime Factor": largestPrimeFactor,
  "Subarray with Maximum Sum": subarrayMaxSum,
  "Total Ways to Sum": totalWaysToSum,
  "Total Ways to Sum II": totalWaysToSumII,
  "Spiralize Matrix": spiralize,
  "Array Jumping Game": arrayJumping,
  "Array Jumping Game II": arrayJumpingII,
  "Merge Overlapping Intervals": mergeIntervals,
  "Generate IP Addresses": generateIPs,
  "Algorithmic Stock Trader I": (p) => stockK(1, p),
  "Algorithmic Stock Trader II": (p) => stockK(p.length, p),
  "Algorithmic Stock Trader III": (p) => stockK(2, p),
  "Algorithmic Stock Trader IV": ([k, p]) => stockK(k, p),
  "Minimum Path Sum in a Triangle": triangleMinPath,
  "Unique Paths in a Grid I": uniquePathsI,
  "Unique Paths in a Grid II": uniquePathsII,
  "Shortest Path in a Grid": shortestPath,
  "Sanitize Parentheses in Expression": sanitizeParens,
  "Find All Valid Math Expressions": mathExpressions,
  "HammingCodes: Integer to Encoded Binary": hammingEncode,
  "HammingCodes: Encoded Binary to Integer": hammingDecode,
  "Proper 2-Coloring of a Graph": twoColoring,
  "Compression I: RLE Compression": rle,
  "Compression II: LZ Decompression": lzDecompress,
  "Compression III: LZ Compression": lzCompress,
  "Encryption I: Caesar Cipher": caesar,
  "Encryption II: Vigenère Cipher": vigenere,
  "Square Root": squareRoot,
  "Total Number of Primes": totalPrimesInRange,
  "Largest Rectangle in a Matrix": largestRectangle,
};
