#!/usr/bin/env node
/**
 * BUYER AGENT v3 — Multi-Agent Collaboration
 * Automatically hires 2+ agents for complex tasks, chains outputs between them.
 * Usage: node buyer-agent.cjs
 */

try { require('ethers'); } catch(e) {
  const { execSync } = require('child_process');
  console.log('📦 Installing ethers.js (one-time)...');
  execSync('npm install ethers@5.7', { stdio: 'inherit', cwd: __dirname });
}

const ethers = require('ethers');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const http = require('http');
const https = require('https');

const E6 = ethers.version && ethers.version.startsWith('6');
const signTypedData = (w, d, t, m) => E6 ? w.signTypedData(d, t, m) : w._signTypedData(d, t, m);
const parseSig = (s) => E6 ? ethers.Signature.from(s) : ethers.utils.splitSignature(s);
const fmtUnits = (v, d) => E6 ? ethers.formatUnits(v, d) : ethers.utils.formatUnits(v, d);
const fmtEth = (v) => E6 ? ethers.formatEther(v) : ethers.utils.formatEther(v);
const makeProv = (u) => E6 ? new ethers.JsonRpcProvider(u) : new ethers.providers.JsonRpcProvider(u);

function normalizeValue(v) {
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === 'object') {
    const e = Object.entries(v).filter(([, n]) => n !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k, n]) => [k, normalizeValue(n)]);
    return Object.fromEntries(e);
  }
  return v;
}
function canonicalDigest(p) {
  const j = JSON.stringify(normalizeValue(p));
  return { stableJson: j, sha256Hex: crypto.createHash('sha256').update(j, 'utf-8').digest('hex') };
}
function jsonSafe(o) {
  if (typeof o === 'bigint') return o.toString();
  if (Array.isArray(o)) return o.map(jsonSafe);
  if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = jsonSafe(v); return r; }
  return o;
}

const API_BASE = 'https://api.santaclawz.ai';
const BASE_RPC = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const AGENTS = [
  { name:'Zaitek Technologies', id:'zaitek-technologies--session_agent_b4a646d96b37', price:1.00, tags:['image','visual'] },
  { name:'zaiclaw', id:'zaiclaw--session_agent_1ef352f6cda1', price:0.25, tags:['text','write','research'] },
  { name:'Code Audit Agent', id:'code-audit-agent--session_agent_51a8f5e04659', price:1.00, tags:['audit','security'] },
  { name:'Agent Job Pack', id:'agent-job-pack--session_agent_481978b8e6ea', price:0.25, tags:['pack','proposal'] },
  { name:'Zaitek Technologies (Windows)', id:'zaitek-technologies-windows--session_agent_788cc04c082a', price:0.25, tags:['windows','doc'] },
];

// ─── MULTI-AGENT PLANNER ───
// Analyzes a task and builds a plan of 1-3 sequential hires
function buildPlan(task) {
  const t = task.toLowerCase();
  const steps = [];

  // Detect what's needed
  const needsResearch = /article|blog|news|research|report|write|content|story|website|top.*list|top.*10|trending|summary/i.test(t);
  const needsImage = /image|picture|photo|generate|draw|illustrate|art|graphic|design|poster|banner|logo|meme|visual.*(of|for)|create.*image|infographic|artwork/i.test(t);
  const needsAudit = /audit|smart contract|solidity|vulnerability|reentrancy|exploit.*find|security.*review/i.test(t);
  const needsProposal = /proposal|bid|job pack|qa.*checklist|risk.*register/i.test(t);

  // Multi-step: RESEARCH → WRITE (zaiclaw) then IMAGE (Zaitek)
  if (needsResearch && needsImage) {
    steps.push({
      agent: AGENTS[1], // zaiclaw — research + write
      prompt: task,
      contextField: null
    });
    steps.push({
      agent: AGENTS[0], // Zaitek — image from article
      prompt: null, // will be filled from previous output
      contextField: 'previous-text',
      derivePrompt: (prevResult) => {
        // Extract first 200 chars of the article to use as image prompt
        const articleText = prevResult.textOutput || '';
        const titleMatch = articleText.match(/# ([^\n]+)/);
        const title = titleMatch ? titleMatch[1] : '';
        const snippet = articleText.replace(/[#*`]/g,'').substring(0, 300).trim();
        return `Create a professional image for a crypto article titled "${title}". The article covers: ${snippet}. Design a modern, clean visual suitable for a tech website header.`;
      }
    });
    return steps;
  }

  // Single-agent: pure image
  if (needsImage && !needsResearch) {
    steps.push({ agent: AGENTS[0], prompt: task, contextField: null });
    return steps;
  }

  // Single-agent: pure text
  if (needsResearch) {
    steps.push({ agent: AGENTS[1], prompt: task, contextField: null });
    return steps;
  }

  // Audit
  if (needsAudit) {
    steps.push({ agent: AGENTS[2], prompt: task, contextField: null });
    return steps;
  }

  // Default: zaiclaw
  steps.push({ agent: AGENTS[1], prompt: task, contextField: null });
  return steps;
}

// ─── DOWNLOAD ───
function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

async function downloadDeliverables(hireResult, outputDir) {
  const deliverables = hireResult.data?.verified_output?.deliverables || [];
  const files = [];
  let textOutput = hireResult.data?.verified_output?.buyer_visible_outputs?.[0]?.text || '';

  for (const d of deliverables) {
    const name = d.name || 'file';
    const uri = d.uri;
    if (!uri) continue;
    try {
      console.log(`   📥 ${name}...`);
      const buf = await downloadUrl(uri);
      const fp = path.join(outputDir, name);
      fs.writeFileSync(fp, buf);
      const kb = (buf.length/1024).toFixed(1);
      console.log(`   ✅ ${name} (${kb} KB)`);
      files.push({ name, path: fp, size: buf.length });
    } catch(e) { console.log(`   ⚠️ ${name} failed: ${e.message}`); }
  }

  return { files, textOutput };
}

// ─── HIRE ENGINE ───
async function hireAgent(agent, task, wallet, usdc) {
  const preflight = await fetch(`${API_BASE}/api/agents/${agent.id}/hire`, {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ taskPrompt: task, requesterContact: `buyer:${wallet.address}` })
  });
  const hireResp = await preflight.json();
  const accept = hireResp.accepts?.[0];
  if (!accept) throw new Error(hireResp.error || 'no accept available');

  const fees = accept.extensions?.evm?.feeSplit;
  const requestId = hireResp.requestId;
  const sellerAmount = BigInt(fees.sellerAmount);
  const protocolAmount = BigInt(fees.protocolFeeAmount);
  const sellerPayTo = fees.sellerPayTo;
  const protocolPayTo = fees.protocolFeePayTo;
  const validBefore = BigInt(Math.floor(Date.now()/1000)+3600);
  const domain = { name:'USD Coin', version:'2', chainId:8453, verifyingContract: USDC_ADDRESS };
  const types = { TransferWithAuthorization: [
    { name:'from', type:'address' }, { name:'to', type:'address' },
    { name:'value', type:'uint256' }, { name:'validAfter', type:'uint256' },
    { name:'validBefore', type:'uint256' }, { name:'nonce', type:'bytes32' },
  ]};

  const sellerNonce = '0x'+crypto.randomBytes(32).toString('hex');
  const sellerMsg = { from:wallet.address, to:sellerPayTo, value:sellerAmount, validAfter:0n, validBefore, nonce:sellerNonce };
  const sellerSig = await signTypedData(wallet, domain, types, sellerMsg);
  const sellerP = parseSig(sellerSig);

  const protocolNonce = '0x'+crypto.randomBytes(32).toString('hex');
  const protocolMsg = { from:wallet.address, to:protocolPayTo, value:protocolAmount, validAfter:0n, validBefore, nonce:protocolNonce };
  const protocolSig = await signTypedData(wallet, domain, types, protocolMsg);
  const protocolP = parseSig(protocolSig);

  const amount = accept.price;
  const paymentId = 'pay_'+crypto.randomBytes(16).toString('hex');
  const now = new Date();
  const payload = {
    protocol:'x402', networkId:'eip155:8453', settlementRail:'evm',
    requestId, payTo:accept.payTo, paymentId,
    issuedAtIso:now.toISOString(), expiresAtIso:new Date(now.getTime()+3600000).toISOString(),
    amount, asset:accept.asset, scheme:'exact',
    extensions:{ evm:{ amountUnit:'atomic' } },
    authorization:{ typedData:{ domain, types, message:sellerMsg }, signature:sellerSig },
    accepted:{
      network:'eip155:8453', payTo:accept.payTo, asset:USDC_ADDRESS, amount,
      extra:{ feeSplit:{ grossAmount:amount, sellerAmount:fees.sellerAmount, protocolFeeAmount:fees.protocolFeeAmount, protocolFeePayTo:fees.protocolFeePayTo, protocolFeePayToLabel:'SantaClawz Protocol Fee', protocolFeeRecipient:fees.protocolFeePayTo, sellerPayTo:fees.sellerPayTo, feeSettlementMode:'exact-eip3009-split-v1', version:'protocol-owner-fee-v1', feeBps:fees.feeBps } }
    },
    payload:{ signature:sellerSig, authorization:{ from:wallet.address, to:sellerPayTo, value:sellerAmount.toString(), validAfter:'0', validBefore:validBefore.toString(), nonce:sellerNonce, v:'0x'+sellerP.v.toString(16), r:sellerP.r, s:sellerP.s }, feeAuthorization:{ signature:protocolSig, authorization:{ from:wallet.address, to:protocolPayTo, value:protocolAmount.toString(), validAfter:'0', validBefore:validBefore.toString(), nonce:protocolNonce, v:'0x'+protocolP.v.toString(16), r:protocolP.r, s:protocolP.s } } },
    feeAuthorization:{ typedData:{ domain, types, message:protocolMsg }, signature:protocolSig },
    resource:{ url:hireResp.resource, description:'SantaClawz agent hire', mimeType:'application/json' },
  };

  const { sha256Hex: authDigest } = canonicalDigest(jsonSafe(payload));
  payload.authorizationDigest = authDigest;

  // On-chain protocol fee
  try {
    const tx = await usdc.transferWithAuthorization(wallet.address, protocolPayTo, protocolAmount, 0n, validBefore, protocolNonce, protocolP.v, protocolP.r, protocolP.s);
    await tx.wait();
  } catch(e) {
    try {
      const tx2 = await usdc.transferWithAuthorization(wallet.address, protocolPayTo, protocolAmount, 0n, validBefore, protocolNonce, protocolP.v, protocolP.r, protocolP.s, { gasLimit:100000 });
      await tx2.wait();
    } catch(e2) {}
  }

  // Small delay between hires to avoid nonce conflicts
  await new Promise(r => setTimeout(r, 2000));

  const body = { taskPrompt:task, requesterContact:`buyer:${wallet.address}`, paymentPayload:payload };
  const res = await fetch(`${API_BASE}/api/agents/${agent.id}/hire`, {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(jsonSafe(body)),
  });
  const data = await res.json().catch(()=>({}));
  if (res.status>=400) throw new Error(data.error||`HTTP ${res.status}`);
  return { requestId:data.requestId, status:data.status, paymentStatus:data.paymentStatus, data };
}

// ─── MAIN ───
async function main() {
  console.log(`
╔════════════════════════════════════════════════════════╗
║  🤖 BUYER AGENT v3 — MULTI-AGENT COLLAB              ║
║  Auto-detects complex tasks → hires 2+ agents in seq ║
║  e.g. "article + image" → zaiclaw writes → Zaitek    ║
║        generates image based on the article           ║
╚════════════════════════════════════════════════════════╝
`);

  const rl = readline.createInterface({ input:process.stdin, output:process.stdout });
  const q = (q) => new Promise(r => rl.question(q, r));

  let pk = process.env.BUYER_PK || '';
  if (!pk) { pk = (await q('🔐 Private key (0x...): ')).trim(); if (!pk.startsWith('0x')) pk = '0x'+pk; }

  const provider = makeProv(BASE_RPC);
  let wallet;
  try { wallet = new ethers.Wallet(pk, provider); }
  catch(e) { console.log('❌ Invalid key'); process.exit(1); }
  console.log(`👤 ${wallet.address}`);

  const usdc = new ethers.Contract(USDC_ADDRESS, [
    'function balanceOf(address) view returns (uint256)',
    'function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external',
  ], provider);
  let bal, eth;
  try { bal = await usdc.balanceOf(wallet.address); eth = await provider.getBalance(wallet.address); }
  catch(e) { console.log('❌ RPC error'); process.exit(1); }
  console.log(`💰 USDC: $${fmtUnits(bal,6)} | ETH: ${fmtEth(eth).substring(0,8)}`);
  if (bal.isZero()) { console.log('❌ No USDC'); process.exit(1); }

  const agentRes = await fetch(`${API_BASE}/api/agents`);
  const allAgents = await agentRes.json();
  const hireable = allAgents.filter(a => a.readiness?.hireable && a.runtimeStatus === 'live');
  console.log(`📋 ${hireable.length} agents available\n`);
  for (const a of hireable) console.log(`   ${a.agentName.padEnd(32)} $${(a.fixedAmountUsd||'?').padEnd(5)}`);

  const outDir = path.join(process.cwd(), 'output');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('\n┌─ Chat ───────────────────────────────────────────────────────┐');
  console.log('│ Tasks are auto-analyzed. Complex tasks spawn multiple hires. │');
  console.log('│ Examples:                                                    │');
  console.log('│   "article on PH crypto + create an image for it"            │');
  console.log('│     → zaiclaw researches & writes → Zaitek generates image   │');
  console.log('│   "top 10 NFTs right now" → zaiclaw writes                   │');
  console.log('│   "generate a poster" → Zaitek generates                     │');
  console.log('└──────────────────────────────────────────────────────────────┘\n');

  let running = true;
  while (running) {
    const input = (await q('> ')).trim();
    const cmd = input.toLowerCase();
    if (!input) continue;
    if (/^(quit|exit|q)$/.test(cmd)) { console.log('👋 Bye!'); running = false; break; }
    if (cmd === 'balance') { const b = await usdc.balanceOf(wallet.address); console.log(`💰 $${fmtUnits(b,6)}`); continue; }
    if (cmd === 'agents'||cmd==='list') { for (const a of hireable) console.log(`   ${a.agentName.padEnd(32)} $${(a.fixedAmountUsd||'?').padEnd(5)}`); continue; }

    const plan = buildPlan(input);
    const totalCost = plan.reduce((s, s2) => s + s2.agent.price, 0);
    const usdcBal = parseFloat(fmtUnits(await usdc.balanceOf(wallet.address), 6));
    if (usdcBal < totalCost) { console.log(`❌ Need $${totalCost.toFixed(2)} but have $${usdcBal.toFixed(2)}`); continue; }

    console.log(`📋 Plan: ${plan.length} step(s) — $${totalCost.toFixed(2)}\n`);

    const jobDir = path.join(outDir, `${Date.now().toString(36)}_plan`);
    fs.mkdirSync(jobDir, { recursive: true });
    let allFiles = [];
    let prevText = '';

    let stepOk = true;
    for (let i = 0; i < plan.length && stepOk; i++) {
      const step = plan[i];
      // Build prompt for this step
      let prompt = step.prompt;
      if (step.derivePrompt && prevText) {
        prompt = step.derivePrompt({ textOutput: prevText });
      } else if (!prompt) {
        prompt = input;
      }

      console.log(`\n─── Step ${i+1}: ${step.agent.name} ($${step.agent.price.toFixed(2)}) ───`);
      console.log(`   Prompt: ${prompt.substring(0, 80)}...`);

      try {
        const result = await hireAgent(step.agent, prompt, wallet, usdc);
        console.log(`   ✅ ${result.status} | Payment: ${result.paymentStatus}`);

        const { files, textOutput } = await downloadDeliverables(result, jobDir);
        allFiles = allFiles.concat(files);

        if (textOutput) {
          // Save article text for next step context
          const textFile = path.join(jobDir, `step${i+1}-output.txt`);
          fs.writeFileSync(textFile, textOutput);
          if (!files.find(f => f.name === `step${i+1}-output.txt`)) {
            allFiles.push({ name: `step${i+1}-output.txt`, path: textFile, size: textOutput.length });
          }
          prevText = textOutput;
          console.log(`   📝 Got text output (${(textOutput.length/1024).toFixed(1)} KB)`);
        }

        // Refresh balance
        bal = await usdc.balanceOf(wallet.address);
        console.log(`   💰 $${fmtUnits(bal, 6)} remaining`);
      } catch(e) {
        console.log(`   ❌ Step failed: ${e.message}`);
        stepOk = false;
      }
    }

    if (allFiles.length > 0) {
      console.log(`\n✅ Plan complete — ${allFiles.length} file(s) in ${jobDir}`);
      for (const f of allFiles) {
        const ext = path.extname(f.name).toLowerCase();
        const icon = ['.jpg','.jpeg','.png','.gif','.webp'].includes(ext) ? '🖼️' :
                     ['.md','.txt'].includes(ext) ? '📄' : '📎';
        const sz = f.size > 1024 ? `${(f.size/1024).toFixed(1)} KB` : `${f.size} B`;
        console.log(`   ${icon} ${f.name} (${sz})`);
      }
    } else {
      console.log('\n⚠️ No files delivered');
    }
    console.log(`\n💰 Balance: $${fmtUnits(await usdc.balanceOf(wallet.address), 6)}\n`);
  }
  rl.close();
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
