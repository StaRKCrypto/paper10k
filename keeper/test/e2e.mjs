#!/usr/bin/env node
// End-to-end test of the keeper against a THROWAWAY local anvil chain (port 8546) using anvil's PUBLIC dev mnemonic (worthless keys).
// Deploys the real contracts with the repo's Deploy script (chain 31337 => TestUSDC + SignedPriceOracle), then exercises:
// dry-run, gas cap, recovery->clearMark, and the live mark -> wait 2 blocks -> liquidate flow with bounty accounting.
import { spawn, execSync } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, defineChain, formatUnits } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const RPC = 'http://127.0.0.1:8546', MN = 'test test test test test test test test test test test junk';
const acct = (i) => mnemonicToAccount(MN, { addressIndex: i });
const PATH = process.env.PATH + ':' + process.env.HOME + '/.foundry/bin';
const sh = (c, env = {}) => execSync(c, { env: { ...process.env, PATH, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'e', symbol: 'e', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC) });
const wcFor = (i) => createWalletClient({ account: acct(i), chain, transport: http(RPC) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fails++; };
const procs = []; const cleanup = () => procs.forEach((p) => { try { p.kill('SIGTERM'); } catch {} });
process.on('exit', cleanup); process.on('SIGINT', () => process.exit(130));

// ---- chain + deploy
const anvil = spawn('anvil', ['--port', '8546', '--block-time', '1', '--silent'], { env: { ...process.env, PATH }, stdio: 'ignore' }); procs.push(anvil);
for (let i = 0; i < 40; i++) { try { await pc.getBlockNumber(); break; } catch { await sleep(250); } }
const owner = acct(0), ownerKey = owner.getHdKey().privateKey; const OK = '0x' + Buffer.from(ownerKey).toString('hex');
const out = sh(`cd ${process.cwd()}/../contracts && forge script script/Deploy.s.sol --rpc-url ${RPC} --private-key ${OK} --broadcast 2>&1`, { OWNER: owner.address, ORACLE_SIGNER: owner.address, CONFIG_DELAY: '300' });
const get = (k) => out.split('\n').find((l) => new RegExp(`^\\s+${k} `).test(l)).trim().split(/\s+/)[1];
const USDC = get('TestUSDC'), ORC = get('Oracle'), PX = get('PAPER10KX'), EX = get('Exchange');
console.log({ USDC, ORC, PX, EX });
const send = async (i, address, abi, functionName, args = []) => { const h = await wcFor(i).writeContract({ address, abi: parseAbi(abi), functionName, args }); return pc.waitForTransactionReceipt({ hash: h }); };
const exAbi = ['function proposeMarket(uint32,bool,uint256,uint256)', 'function applyMarket(uint32)', 'function seedPool(uint256)', 'function unpause()', 'function deposit(uint256)', 'function open(uint32,bool,uint256,uint32,uint256) returns (uint256)', 'function markLiquidatable(uint256)', 'function free(address) view returns (uint256)', 'function positions(uint256) view returns (address,uint32,uint16,uint32,bool,uint128,uint128,uint128,uint64,uint32)', 'function marks(uint256) view returns (uint32,uint64)', 'function pool() view returns (uint256)', 'function insurance() view returns (uint256)'];
const usdcAbi = ['function faucet()', 'function approve(address,uint256)', 'function balanceOf(address) view returns (uint256)'];
await send(0, PX, ['function acceptOwnership()'], 'acceptOwnership');
await send(0, EX, exAbi, 'proposeMarket', [0, true, 10n ** 12n, 10n ** 12n]);
await pc.request({ method: 'evm_increaseTime', params: [301] }); await pc.request({ method: 'evm_mine', params: [] });
await send(0, EX, exAbi, 'applyMarket', [0]);
await send(0, USDC, usdcAbi, 'faucet'); await send(0, USDC, usdcAbi, 'approve', [EX, 10_000_000_000n]); await send(0, EX, exAbi, 'seedPool', [10_000_000_000n]);
await send(0, EX, exAbi, 'unpause');

// ---- price feeder (testnet SignedPriceOracle; owner is the signer). Keeps the price fresh (maxPriceAge 30 s) and strictly increasing in ts.
let price = 100_000, lastTs = 0n; const oAbi = parseAbi(['function updatePrice(uint32,uint256,uint64,bytes)']);
const types = { Price: [{ name: 'market', type: 'uint32' }, { name: 'price', type: 'uint256' }, { name: 'timestamp', type: 'uint64' }] };
async function publish() {
  const bt = (await pc.getBlock()).timestamp; const ts = bt > lastTs ? bt : lastTs + 1n; lastTs = ts;
  const p = BigInt(Math.round(price * 1e6)) * 10n ** 12n;
  const signature = await owner.signTypedData({ domain: { name: 'Paper10kOracle', version: '1', chainId: 31337, verifyingContract: ORC }, types, primaryType: 'Price', message: { market: 0, price: p, timestamp: ts } });
  await wcFor(0).writeContract({ address: ORC, abi: oAbi, functionName: 'updatePrice', args: [0, p, ts, signature] });
}
let feeding = true; (async () => { while (feeding) { try { await publish(); } catch (e) { /* race with own nonce: ignore */ } await sleep(2500); } })();
const setPrice = async (p) => { price = p; await sleep(3500); };
await setPrice(100_000);

// ---- users: 4 long positions at 10000x with 20 USDC margin each (alice, bob, carol, dave = dev accounts 1,3,4,5); keeper = dev account 2
const users = [1, 3, 4, 5]; const ids = [];
for (const u of users) {
  await send(u, USDC, usdcAbi, 'faucet'); await send(u, USDC, usdcAbi, 'approve', [EX, 1_000_000_000n]); await send(u, EX, exAbi, 'deposit', [500_000_000n]);
  const r = await send(u, EX, exAbi, 'open', [0, true, 20_000_000n, 10_000, 2n ** 255n]);
  const idLog = r.logs.find((l) => l.address.toLowerCase() === EX.toLowerCase()); ids.push(BigInt(idLog.topics[1]));
}
console.log('position ids', ids.map(String));
const KEEPER = acct(2); const KEEPER_KEY = '0x' + Buffer.from(KEEPER.getHdKey().privateKey).toString('hex');
await send(0, USDC, ['function transfer(address,uint256)'], 'transfer', [KEEPER.address, 0n]).catch(() => {});
const view = (fn, args) => pc.readContract({ address: EX, abi: parseAbi(exAbi), functionName: fn, args });
const markOf = async (id) => (await view('marks', [id]))[0];
const alive = async (id) => (await view('positions', [id]))[0] !== '0x0000000000000000000000000000000000000000';
const baseEnv = { RPC_URL: RPC, EXCHANGE: EX, CHAIN_ID: '31337', LOG_LEVEL: 'debug', POLL_MS: '500' };
const runKeeper = (env, args = []) => { try { return sh(`node src/cli.mjs ${args.join(' ')}`, { ...baseEnv, ...env }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const events = (txt) => txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });

// ---- S1 dry run: positions busted, keeper has NO key => forced dry-run
await setPrice(99_980);
let log = events(runKeeper({}, ['--once']));
check('dry-run: would send markLiquidatable for all 4', log.filter((e) => e.event === 'dry_run_would_send' && e.fn === 'markLiquidatable').length === 4, JSON.stringify(log.filter((e) => e.event === 'dry_run_would_send').map((e) => [e.event, e.id])));
check('dry-run: nothing on chain', (await Promise.all(ids.map(markOf))).every((m) => m === 0));
// ---- S2 gas cap
log = events(runKeeper({ KEEPER_PRIVATE_KEY: KEEPER_KEY, MAX_GAS_PRICE_GWEI: '0.0000001' }, ['--once']));
check('gas cap: skipped with gas_price_above_cap', log.some((e) => e.event === "gas_price_above_cap") && (await Promise.all(ids.map(markOf))).every((m) => m === 0));
// ---- S3 recovery: someone marks carol's position, price recovers, keeper clears it
await send(3, EX, exAbi, 'markLiquidatable', [ids[2]]);
check('setup: carol position is marked', (await markOf(ids[2])) !== 0);
await setPrice(100_000);
log = events(runKeeper({ KEEPER_PRIVATE_KEY: KEEPER_KEY }, ['--once']));
check('recovery: keeper sent clearMark and mark is cleared', log.some((e) => e.event === 'tx_success' && e.fn === 'clearMark' && e.id === ids[2].toString()) && (await markOf(ids[2])) === 0, '');
// ---- S4 live mark -> 2 blocks -> liquidate with bounty
const freeBefore = await view('free', [KEEPER.address]); const poolBefore = await view('pool', []), insBefore = await view('insurance', []);
await setPrice(99_980);
const kl = createWriteStream('/tmp/keeper-e2e.log');
const keeper = spawn('node', ['src/cli.mjs'], { env: { ...process.env, PATH, ...baseEnv, KEEPER_PRIVATE_KEY: KEEPER_KEY, LOG_LEVEL: 'info' }, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(keeper);
let buf = ''; keeper.stdout.on('data', (d) => { buf += d; kl.write(d); }); keeper.stderr.on('data', (d) => { buf += d; kl.write(d); });
for (let i = 0; i < 60; i++) { await sleep(1000); if ((await Promise.all(ids.map(alive))).every((a) => !a)) break; }
await sleep(4000); keeper.kill('SIGTERM');
const ev = events(buf);
check('live: all 4 positions liquidated', (await Promise.all(ids.map(alive))).every((a) => !a));
const marks = ev.filter((e) => e.event === 'tx_success' && e.fn === 'markLiquidatable'), liqs = ev.filter((e) => e.event === 'tx_success' && e.fn === 'liquidate');
check('live: markLiquidatable then liquidate txs succeeded', marks.length >= 4 && liqs.length >= 4, `marks=${marks.length} liqs=${liqs.length}`);
// persistence: every liquidation happened >= 2 blocks after that position's mark, and before the TTL
const okGap = ids.every((id) => { const m = marks.find((e) => e.id === id.toString()), l = liqs.find((e) => e.id === id.toString()); return m && l && BigInt(l.block) - BigInt(m.block) >= 2n; });
check('keeper waited >= 2 blocks between mark and liquidate for every position', okGap);
const bountyGot = (await view('free', [KEEPER.address])) - freeBefore;
check('bounty: keeper credited 4 x 2% of 20 USDC = 1.6 USDC', bountyGot === 1_600_000n, `got ${formatUnits(bountyGot, 6)}`);
const houseGot = (await view('pool', [])) - poolBefore + ((await view('insurance', [])) - insBefore);
check('house received margin minus bounties (80 - 1.6 = 78.4 USDC)', houseGot === 78_400_000n, `got ${formatUnits(houseGot, 6)}`);
const pxBal = await pc.readContract({ address: PX, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [acct(1).address] });
check('PAPER10KX minted to a liquidated owner', pxBal > 0n);
feeding = false; cleanup();
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL KEEPER E2E CHECKS PASSED'); process.exit(fails ? 1 : 0);
