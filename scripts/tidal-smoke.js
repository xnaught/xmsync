const url = 'http://localhost:8787/api/tidal/smoke';

try {
  const response = await fetch(url, { method: 'POST', headers: { Origin: 'http://localhost:8787' } });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok || !result.passed) process.exitCode = 1;
} catch {
  console.error('Start xmsync, connect TIDAL in the browser, then run npm run tidal:smoke again.');
  process.exitCode = 1;
}
