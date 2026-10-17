// Timing utilities built for a noisy, oversubscribed machine.
//
// - The primary metric is process CPU time (user + system) rather than wall
//   time. Under heavy load wall time mostly measures how long the scheduler
//   kept us waiting; CPU time measures the work we actually did.
// - Variants are interleaved round by round (A, B, A, B, ...), so slow drift in
//   machine load hits every variant equally instead of biasing whichever ran
//   last.
// - Results are medians over rounds, with the interquartile range shown so
//   noise is visible rather than hidden.

const gc = globalThis.gc ?? (() => {});

function cpuMs() {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    median: quantile(s, 0.5),
    p25: quantile(s, 0.25),
    p75: quantile(s, 0.75),
    min: s[0],
  };
}

/**
 * Runs each variant `rounds` times, interleaved, after `warmup` untimed rounds.
 * Each variant is a zero-argument function doing one full unit of work (for
 * example, parsing the whole corpus once). Returns CPU-ms stats per variant.
 */
export function compare(variants, { rounds = 15, warmup = 3 } = {}) {
  const names = Object.keys(variants);
  const cpu = Object.fromEntries(names.map((n) => [n, []]));
  const wall = Object.fromEntries(names.map((n) => [n, []]));

  for (let r = 0; r < warmup + rounds; r++) {
    // Rotate the starting variant so none systematically runs first.
    const order = names.map((_, i) => names[(i + r) % names.length]);
    for (const name of order) {
      gc();
      const c0 = cpuMs();
      const w0 = performance.now();
      variants[name]();
      const c1 = cpuMs();
      const w1 = performance.now();
      if (r >= warmup) {
        cpu[name].push(c1 - c0);
        wall[name].push(w1 - w0);
      }
    }
  }

  return Object.fromEntries(
    names.map((n) => [n, { cpu: summarize(cpu[n]), wall: summarize(wall[n]) }])
  );
}

export function fmtMs(x) {
  if (x >= 100) return x.toFixed(0) + ' ms';
  if (x >= 10) return x.toFixed(1) + ' ms';
  return x.toFixed(2) + ' ms';
}

export function fmtBytes(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n + ' B';
}

/** Prints a comparison table; the first variant is the reference. */
export function report(title, results) {
  const names = Object.keys(results);
  const ref = results[names[0]].cpu.median;
  console.log(`\n${title}`);
  console.log(
    '  variant'.padEnd(34) +
      'cpu median'.padStart(12) +
      '   IQR'.padEnd(22) +
      'vs ' +
      names[0]
  );
  for (const n of names) {
    const { median, p25, p75 } = results[n].cpu;
    const ratio = ref / median;
    console.log(
      `  ${n}`.padEnd(34) +
        fmtMs(median).padStart(12) +
        `   ${fmtMs(p25)}–${fmtMs(p75)}`.padEnd(22) +
        (n === names[0] ? '—' : `${ratio.toFixed(2)}x ${ratio >= 1 ? 'faster' : 'slower'}`)
    );
  }
}
