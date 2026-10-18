// ORDER 8 DIAGNOSTIC: the JS process clock lags the OS precise clock by KAURO_ORDER8_LAG_MS (what V8 does on Windows: Date.now() is a
// GetSystemTimeAsFileTime baseline, behind the precise clock by up to one system tick, extrapolated with QPC and resynced each minute),
// while PostgreSQL's now() reads GetSystemTimePreciseAsFileTime. A negative value makes the process clock lead instead.
const lag = Number(process.env.KAURO_ORDER8_LAG_MS ?? 0);
if (lag !== 0) {
  const real = Date.now;
  Date.now = () => real() - lag;
}
