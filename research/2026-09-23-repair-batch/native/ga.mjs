import { createSign } from "node:crypto"; import { readFileSync } from "node:fs";
const key = JSON.parse(readFileSync(process.env.HOME + "/.vaxis-secrets/gsc/service-account.json", "utf8"));
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now()/1000);
const jwt = b64({alg:"RS256",typ:"JWT"}) + "." + b64({iss:key.client_email, scope:"https://www.googleapis.com/auth/analytics.readonly", aud:key.token_uri, iat:now, exp:now+3600});
const sig = createSign("RSA-SHA256").update(jwt).sign(key.private_key, "base64url");
const tok = await (await fetch(key.token_uri, {method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"}, body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}.${sig}`})).json();
const H = {authorization:"Bearer "+tok.access_token, "content-type":"application/json"};
const P = "properties/526101383";
const mode = process.argv[2];
if (mode === "meta") {
  for (const kind of ["customDimensions","customMetrics"]) {
    const r = await (await fetch(`https://analyticsadmin.googleapis.com/v1beta/${P}/${kind}?pageSize=200`, {headers:H})).json();
    console.log(kind, (r[kind]||[]).map(d=>`${d.parameterName}(${d.scope}${d.measurementUnit?","+d.measurementUnit:""})`).join(", "));
  }
} else {
  const body = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const r = await (await fetch(`https://analyticsdata.googleapis.com/v1beta/${P}:runReport`, {method:"POST", headers:H, body:JSON.stringify(body)})).json();
  if (r.error) { console.log(JSON.stringify(r.error)); process.exit(1); }
  const dh = (r.dimensionHeaders||[]).map(h=>h.name), mh=(r.metricHeaders||[]).map(h=>h.name);
  console.log([...dh,...mh].join(" | "));
  for (const row of r.rows||[]) console.log([...row.dimensionValues.map(v=>v.value), ...row.metricValues.map(v=>v.value)].join(" | "));
  console.log(`(${r.rowCount||0} rows)`);
}
