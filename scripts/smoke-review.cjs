#!/usr/bin/env node
// Read-only probes against this task's isolated dev host. No external URL option.
const fs = require('node:fs');
const path = require('node:path');
const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({
  oid: '00000000-0000-0000-0000-000000000001', name: 'Local review probe',
  preferred_username: 'probe@review.invalid', exp: Math.floor(Date.now()/1000)+300,
})).toString('base64url')}.local`;
const probes = [
  ['getBuildings','admin',200], ['getProcedures','admin',200],
  ['getFinanceControlsPack','cfo',200], ['getFinanceControlsPack','facilities',403],
  ['getReviewsDue','facilities',403], ['getReviewsDue','accounts',200],
  ['getApprovalLimits','cfo',200], ['getTimesheets','cfo',200],
];
(async () => {
  const report = [];
  for (const [route, role, expected] of probes) {
    const response = await fetch(`http://127.0.0.1:7071/api/${route}`, { headers: { authorization: `Bearer ${token}`, 'x-dev-roles': role } });
    const body = await response.json().catch(() => ({}));
    const item = { route, role, expected, status: response.status, ok: response.status === expected };
    if (!item.ok) item.error = body.error ?? 'Unexpected response';
    if (route === 'getBuildings' && item.ok) item.count = Array.isArray(body) ? body.length : body.buildings?.length;
    if (route === 'getFinanceControlsPack' && item.ok) item.matrixRules = body.snapshot?.matrix?.length;
    report.push(item);
  }
  fs.writeFileSync(path.join(__dirname,'../.review-local/logs/decision-api-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if (report.some(item => !item.ok)) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
