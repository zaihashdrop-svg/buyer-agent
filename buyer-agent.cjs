#!/usr/bin/env node
/**
 * BUYER AGENT v2 — SantaClawz autonomous multi-file buyer terminal
 * Usage: node buyer-agent.cjs
 * Runs on: Windows CMD, PowerShell, Linux/macOS terminal
 *
 * Features:
 *  - Auto-classifies task type and routes to the best SCZ agent
 *  - Downloads ALL deliverables (image.jpg + description.md + etc.)
 *  - Saves files to output/ with proper filenames
 */

// ─── Auto-install ethers if missing ───
try {
  require('ethers');
} catch(e) {
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

// ─── ethers version compat ───
const E6 = ethers.version && ethers.version.startsWith('6');
const signTypedData = (wallet, domain, types, msg) =>
  E6 ? wallet.signTypedData(domain, types, msg) : wallet._signTypedData(domain, types, msg);
const parseSignature = (sig) =>
  E6 ? ethers.Signature.from(sig) : ethers.utils.splitSignature(sig);
const formatUnits = (val, dec) =>
  E6 ? ethers.formatUnits(val, dec) : ethers.utils.formatUnits(val, dec);
const formatEther = (val) =>
  E6 ? ethers.formatEther(val) : ethers.utils.formatEther(val);
const makeProvider = (url) =>
  E6 ? new ethers.JsonRpcProvider(url) : new ethers.providers.JsonRpcProvider(url);

// ─── Stable JSON (exact match for @clawz/protocol) ───
function normalizeValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeValue(item));
    }
    if (value && typeof value === "object") {
        const sortedEntries = Object.entries(value)
            .filter(([, nested]) => nested !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, normalizeValue(nested)]);
        return Object.fromEntries(sortedEntries);
    }
    return value;
}

function canonicalDigest(payload) {
    const normalized = normalizeValue(payload);
    const json = JSON.stringify(normalized);
    const sha256Hex = crypto.createHash("sha256").update(json, "utf-8").digest("hex");
    return { stableJson: json, sha256Hex };
}

function jsonSafe(obj) {
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(jsonSafe);
  if (obj && typeof obj === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(obj)) r[k] = jsonSafe(v);
    return r;
  }
  return obj;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const API_BASE = 'https://api.santaclawz.ai';
const BASE_RPC = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ─── AGENT CATALOG ───
// Each agent: { keywords, id, name, price, description, capabilities }
const AGENTS = [
  {
    id: 'zaitek-technologies--session_agent_b4a646d96b37',
    name: 'Zaitek Technologies',
    price: 1.00,
    keywords: ['image', 'picture', 'photo', 'generate', 'visual', 'draw', 'illustrate',
               'art', 'graphic', 'design', 'poster', 'banner', 'logo', 'meme',
               'artwork', 'infographic', 'create.*(png|jpg)', 'visualize'],
    description: 'Image generation via Grok AI — returns image.jpg + description.md'
  },
  {
    id: 'zaiclaw--session_agent_1ef352f6cda1',
    name: 'zaiclaw',
    price: 0.25,
    keywords: ['text', 'write', 'document', 'article', 'blog', 'summary', 'research',
               'explain', 'report', 'analysis', 'draft', 'markdown', 'content',
               'describe', 'write.*md', 'write.*file', 'generate.*text', 'reply'],
    description: 'Text generation via Hermes AI — returns agent-response.txt'
  },
  {
    id: 'code-audit-agent--session_agent_51a8f5e04659',
    name: 'Code Audit Agent',
    price: 1.00,
    keywords: ['audit', 'security', 'vulnerability', 'reentrancy', 'smart contract',
               'solidity', 'exploit', 'hack', 'review.*code', 'code.*review',
               'bug.*find', 'static.*analysis'],
    description: 'Smart contract security audit'
  },
  {
    id: 'agent-job-pack--session_agent_481978b8e6ea',
    name: 'Agent Job Pack',
    price: 0.25,
    keywords: ['job pack', 'content idea', 'bundle', 'digital product', 'pack',
               'proposal', 'bid', 'qa.*checklist', 'risk.*register'],
    description: 'Bid analysis, proposals, QA checklists'
  },
  {
    id: 'zaitek-technologies-windows--session_agent_788cc04c082a',
    name: 'Zaitek Technologies (Windows)',
    price: 0.25,
    keywords: ['windows', 'spreadsheet', 'excel', 'document.*format', '.docx'],
    description: 'Windows-specific agent for documents/spreadsheets'
  },
];

// ─── Smart task classifier ───
// Uses regex keyword matching + fallback LLM-style routing
function classifyTask(task) {
  const t = task.toLowerCase();

  // Image generation — highest priority match
  if (/image|picture|photo|generate|draw|illustrate|artwork|art.*(of|with)|graphic|design|poster|banner|logo|meme|infographic|visualize|create.*visual|create.*image/i.test(t)) {
    return AGENTS[0]; // Zaitek Technologies — image gen
  }

  // Code audit
  if (/audit|smart contract|solidity|vulnerability|reentrancy|exploit.*find/i.test(t)) {
    return AGENTS[2]; // Code Audit Agent
  }

  // Job pack / proposal
  if (/job pack|bid|proposal|qa.*checklist|risk.*register|bundle|digital product/i.test(t)) {
    return AGENTS[3]; // Agent Job Pack
  }

  // Windows-specific
  if (/windows|excel|spreadsheet|\.docx|powerpoint/i.test(t)) {
    return AGENTS[4]; // Zaitek (Windows)
  }

  // Default: text tasks → zaiclaw (cheapest)
  return AGENTS[1]; // zaiclaw — text gen
}

// ─── Download helpers ───
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

// ─── x402 Hire Engine ───
async function hireAgent(agent, task, wallet) {
  // Preflight
  const preflightRes = await fetch(`${API_BASE}/api/agents/${agent.id}/hire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskPrompt: task, requesterContact: `buyer:${wallet.address}` })
  });
  const hireResp = await preflightRes.json();
  const accept = hireResp.accepts?.[0];
  if (!accept) {
    const errMsg = hireResp.error || hireResp.code || 'no accept available';
    if (hireResp.retryable) throw new Error(`Agent offline (${errMsg}) — try again later`);
    throw new Error(errMsg);
  }

  const fees = accept.extensions?.evm?.feeSplit;
  const requestId = hireResp.requestId;
  const sellerAmount = BigInt(fees.sellerAmount);
  const protocolAmount = BigInt(fees.protocolFeeAmount);
  const sellerPayTo = fees.sellerPayTo;
  const protocolPayTo = fees.protocolFeePayTo;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_ADDRESS };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  };

  // Sign seller + protocol authorizations
  const sellerNonce = '0x' + crypto.randomBytes(32).toString('hex');
  const sellerMsg = { from: wallet.address, to: sellerPayTo, value: sellerAmount, validAfter: 0n, validBefore, nonce: sellerNonce };
  const sellerSig = await signTypedData(wallet, domain, types, sellerMsg);
  const sellerParsed = parseSignature(sellerSig);

  const protocolNonce = '0x' + crypto.randomBytes(32).toString('hex');
  const protocolMsg = { from: wallet.address, to: protocolPayTo, value: protocolAmount, validAfter: 0n, validBefore, nonce: protocolNonce };
  const protocolSig = await signTypedData(wallet, domain, types, protocolMsg);
  const protocolParsed = parseSignature(protocolSig);

  // Build payload
  const amount = accept.price;
  const paymentId = 'pay_' + crypto.randomBytes(16).toString('hex');
  const now = new Date();
  const payload = {
    protocol: 'x402', networkId: 'eip155:8453', settlementRail: 'evm',
    requestId, payTo: accept.payTo, paymentId,
    issuedAtIso: now.toISOString(),
    expiresAtIso: new Date(now.getTime() + 3600000).toISOString(),
    amount, asset: accept.asset, scheme: 'exact',
    extensions: { evm: { amountUnit: 'atomic' } },
    authorization: { typedData: { domain, types, message: sellerMsg }, signature: sellerSig },
    accepted: {
      network: 'eip155:8453', payTo: accept.payTo, asset: USDC_ADDRESS, amount,
      extra: { feeSplit: { grossAmount: amount, sellerAmount: fees.sellerAmount, protocolFeeAmount: fees.protocolFeeAmount, protocolFeePayTo: fees.protocolFeePayTo, protocolFeePayToLabel: 'SantaClawz Protocol Fee', protocolFeeRecipient: fees.protocolFeePayTo, sellerPayTo: fees.sellerPayTo, feeSettlementMode: 'exact-eip3009-split-v1', version: 'protocol-owner-fee-v1', feeBps: fees.feeBps } },
    },
    payload: { signature: sellerSig, authorization: { from: wallet.address, to: sellerPayTo, value: sellerAmount.toString(), validAfter: '0', validBefore: validBefore.toString(), nonce: sellerNonce, v: '0x' + sellerParsed.v.toString(16), r: sellerParsed.r, s: sellerParsed.s }, feeAuthorization: { signature: protocolSig, authorization: { from: wallet.address, to: protocolPayTo, value: protocolAmount.toString(), validAfter: '0', validBefore: validBefore.toString(), nonce: protocolNonce, v: '0x' + protocolParsed.v.toString(16), r: protocolParsed.r, s: protocolParsed.s } } },
    feeAuthorization: { typedData: { domain, types, message: protocolMsg }, signature: protocolSig },
    resource: { url: hireResp.resource, description: 'SantaClawz agent hire', mimeType: 'application/json' },
  };

  // authorizationDigest
  const { sha256Hex: authDigest } = canonicalDigest(jsonSafe(payload));
  payload.authorizationDigest = authDigest;

  // On-chain protocol fee
  const usdc = new ethers.Contract(USDC_ADDRESS, [
    'function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external',
    'function balanceOf(address) view returns (uint256)',
  ], wallet);

  try {
    const tx = await usdc.transferWithAuthorization(
      wallet.address, protocolPayTo, protocolAmount, 0n, validBefore,
      protocolNonce, protocolParsed.v, protocolParsed.r, protocolParsed.s
    );
    await tx.wait();
  } catch(e) {
    try {
      const tx2 = await usdc.transferWithAuthorization(
        wallet.address, protocolPayTo, protocolAmount, 0n, validBefore,
        protocolNonce, protocolParsed.v, protocolParsed.r, protocolParsed.s,
        { gasLimit: 100000 }
      );
      await tx2.wait();
    } catch(e2) {
      // Non-critical
    }
  }

  // Submit
  const body = {
    taskPrompt: task, requesterContact: `buyer:${wallet.address}`,
    paymentPayload: payload,
  };
  const res = await fetch(`${API_BASE}/api/agents/${agent.id}/hire`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(jsonSafe(body)),
  });
  const data = await res.json().catch(() => ({}));

  if (res.status >= 400) throw new Error(data.error || `HTTP ${res.status}`);

  return { requestId: data.requestId, status: data.status, paymentStatus: data.paymentStatus, data };
}

// ─── Download ALL deliverables from a hire response ───
async function downloadDeliverables(result, outputDir) {
  const deliverables = result.data?.verified_output?.deliverables || [];
  if (deliverables.length === 0) {
    console.log('   No file deliverables in response');
    return [];
  }

  const files = [];
  for (const d of deliverables) {
    const name = d.name || `deliverable_${files.length}`;
    const uri = d.uri;
    const sha256 = d.sha256;
    const contentType = d.content_type || 'application/octet-stream';

    if (!uri) {
      console.log(`   ⚠️  ${name} — no URI, skipping`);
      continue;
    }

    try {
      console.log(`   📥 Downloading ${name}...`);
      const buf = await downloadUrl(uri);

      // Verify SHA-256 if available
      if (sha256) {
        const computed = crypto.createHash('sha256').update(buf).digest('hex');
        if (computed !== sha256) {
          console.log(`   ⚠️  SHA-256 mismatch for ${name} — saved anyway`);
        }
      }

      const filePath = path.join(outputDir, name);
      fs.writeFileSync(filePath, buf);
      const sizeKB = (buf.length / 1024).toFixed(1);
      console.log(`   ✅ ${name} (${sizeKB} KB)`);
      files.push({ name, path: filePath, size: buf.length });
    } catch (err) {
      console.log(`   ❌ Failed to download ${name}: ${err.message}`);
    }
  }

  return files;
}

// ─── Main ───
async function main() {
  console.log(`
╔══════════════════════════════════════════════════╗
║      🤖  BUYER AGENT  v2  —  MULTI-FILE         ║
║  Auto-classifies tasks, downloads ALL files     ║
╚══════════════════════════════════════════════════╝
`);

  // Step 1: Private key
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q) => new Promise(r => rl.question(q, r));

  let pk = process.env.BUYER_PK || '';
  if (!pk) {
    pk = (await question('🔐 Enter wallet private key (0x...): ')).trim();
    if (!pk.startsWith('0x')) pk = '0x' + pk;
  }

  // Step 2: Connect
  const provider = makeProvider(BASE_RPC);
  let wallet;
  try {
    wallet = new ethers.Wallet(pk, provider);
  } catch(e) {
    console.log('❌ Invalid private key');
    process.exit(1);
  }
  console.log(`👤 Wallet: ${wallet.address}`);

  // Step 3: Check balance
  const usdc = new ethers.Contract(USDC_ADDRESS, [
    'function balanceOf(address) view returns (uint256)',
    'function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external',
  ], provider);
  let usdcBal, ethBal;
  try {
    usdcBal = await usdc.balanceOf(wallet.address);
    ethBal = await provider.getBalance(wallet.address);
  } catch(e) {
    console.log('❌ Cannot read balances. Check RPC/network.');
    process.exit(1);
  }
  console.log(`💰 USDC: $${formatUnits(usdcBal, 6)} | ETH: ${formatEther(ethBal).substring(0,8)}`);

  if (usdcBal.isZero()) {
    console.log('❌ No USDC. Fund your wallet on Base mainnet first.');
    process.exit(1);
  }

  // Step 4: Fetch available agents
  const agentRes = await fetch(`${API_BASE}/api/agents`);
  const allAgents = await agentRes.json();
  const hireable = allAgents.filter(a => a.readiness?.hireable && a.runtimeStatus === 'live');
  console.log(`📋 ${hireable.length} agents available:\n`);
  for (const a of hireable) {
    console.log(`   ${a.agentName.padEnd(32)} $${(a.fixedAmountUsd || '?').padEnd(5)} ${a.runtimeStatus || ''}`);
  }
  console.log('');

  // Step 5: Output dir
  const outputDir = path.join(process.cwd(), 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  // Step 6: Chat loop
  console.log('┌─ Chat mode ───────────────────────────────────────────────────────────┐');
  console.log('│ Type a task, or: quit | balance | agents | list                       │');
  console.log('│                                                                       │');
  console.log('│ EXAMPLES:                                                             │');
  console.log('│   "generate an image of a cat in space"  → hires Zaitek, gets image   │');
  console.log('│   "write a blog post about AI"           → hires zaiclaw, gets text   │');
  console.log('│   "audit this smart contract..."          → hires Code Audit Agent     │');
  console.log('└───────────────────────────────────────────────────────────────────────┘\n');

  let running = true;
  while (running) {
    const input = (await question('> ')).trim();
    const cmd = input.toLowerCase();

    if (!input) continue;
    if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
      console.log('👋 Bye!');
      running = false;
      break;
    }
    if (cmd === 'balance') {
      const b = await usdc.balanceOf(wallet.address);
      console.log(`💰 USDC: $${formatUnits(b, 6)}`);
      continue;
    }
    if (cmd === 'agents' || cmd === 'list') {
      for (const a of hireable) {
        console.log(`   ${a.agentName.padEnd(32)} $${(a.fixedAmountUsd || '?').padEnd(5)}`);
      }
      continue;
    }

    // Auto-classify task to best agent
    const agent = classifyTask(input);
    const usdcNum = parseFloat(formatUnits(usdcBal, 6));
    if (usdcNum < agent.price) {
      console.log(`❌ Insufficient balance ($${usdcNum.toFixed(2)}) for ${agent.name} ($${agent.price.toFixed(2)})`);
      continue;
    }

    console.log(`🤖 ${agent.name} ($${agent.price.toFixed(2)}) ← ${input.substring(0, 40)}${input.length > 40 ? '...' : ''}`);

    try {
      const result = await hireAgent(agent, input, wallet);

      console.log(`   Status: ${result.status} | Payment: ${result.paymentStatus} | ID: ${result.requestId}`);

      if (result.paymentStatus === 'settled' || result.status === 'completed') {
        usdcBal = await usdc.balanceOf(wallet.address); // refresh

        // Generate slug for output folder
        const slug = input.replace(/[^a-z0-9]/gi, '_').substring(0, 60).toLowerCase();
        const timestamp = Date.now().toString(36);
        const jobDir = path.join(outputDir, `${timestamp}_${slug}`);
        fs.mkdirSync(jobDir, { recursive: true });

        // Download ALL files from the deliverables list
        const downloadedFiles = await downloadDeliverables(result, jobDir);

        if (downloadedFiles.length > 0) {
          console.log(`   📁 ${jobDir} (${downloadedFiles.length} file(s))`);
          for (const f of downloadedFiles) {
            const sizeStr = f.size > 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${f.size} B`;
            const ext = path.extname(f.name).toLowerCase();
            const icon = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext) ? '🖼️' :
                         ['.md', '.txt'].includes(ext) ? '📄' :
                         ['.mp4', '.webm'].includes(ext) ? '🎬' : '📎';
            console.log(`   ${icon} ${f.name} (${sizeStr})`);
          }
        } else {
          // Fallback: save response text
          const summary = JSON.stringify({
            agent: agent.name,
            task: input,
            requestId: result.requestId,
            status: result.status,
            paymentStatus: result.paymentStatus,
            completedAt: new Date().toISOString()
          }, null, 2);
          const summaryPath = path.join(jobDir, 'response.json');
          fs.writeFileSync(summaryPath, summary);
          console.log(`   📄 ${summaryPath}`);
        }

        console.log(`💰 Balance: $${formatUnits(usdcBal, 6)}\n`);
      } else {
        console.log(`⚠️  ${result.status} — payment: ${result.paymentStatus}`);
      }
    } catch(e) {
      console.log(`❌ ${e.message}`);
    }
  }

  rl.close();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
