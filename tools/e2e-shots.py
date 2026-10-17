# Playwright e2e against tools/e2e-local.sh chain, with a mock EIP-1193 provider that forwards to anvil dev account 1 (public key, worthless).
import json, subprocess, os, time, urllib.request
from playwright.sync_api import sync_playwright
OUT = os.environ.get('SHOTS', '/workspace/paper10k-shots'); os.makedirs(OUT, exist_ok=True)
RPC = 'http://127.0.0.1:8545'; ACCTS = {'desktop': '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 'mobile': '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'}; ACCT = ACCTS['desktop']
def rpc(m, p):
    r = urllib.request.urlopen(urllib.request.Request(RPC, json.dumps({'jsonrpc':'2.0','id':1,'method':m,'params':p}).encode(), {'content-type':'application/json'}))
    j = json.loads(r.read()); 
    if 'error' in j: raise Exception(j['error']['message'])
    return j['result']
state = {'chain': '0x1'}   # starts on the WRONG network to show the network check
def handler(method, params):
    if method == 'eth_requestAccounts' or method == 'eth_accounts': return [ACCT]
    if method == 'eth_chainId': return state['chain']
    if method == 'wallet_switchEthereumChain': state['chain'] = params[0]['chainId']; return None
    if method == 'eth_sendTransaction': params[0]['from'] = ACCT; return rpc('eth_sendTransaction', params)
    if method == 'personal_sign': return rpc('personal_sign', params)
    return rpc(method, params)
errs = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for w, h, tag in [(1440, 900, 'desktop'), (390, 844, 'mobile')]:
        if os.environ.get('ONLY') and os.environ['ONLY'] != tag: continue
        pg = b.new_context(viewport={'width': w, 'height': h}).new_page()
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'hyperliquid' not in m.text.lower() and 'ERR_' not in m.text and 'Failed to load resource' not in m.text else None)
        def call(method, params):
            try: return {'ok': handler(method, params)}
            except Exception as e: return {'err': str(e)}
        pg.expose_function('__rpc', call)
        pg.add_init_script("window.ethereum={isMetaMask:true,on(){},request:async({method,params})=>{const r=await window.__rpc(method,params||[]);if(r.err)throw new Error(r.err);return r.ok}}")
        state['chain'] = '0x1'; ACCT = ACCTS[tag]
        pg.goto('http://localhost:8091/?dev=1#onchain'); pg.wait_for_selector('#chainpanel .cbanner'); pg.wait_for_timeout(800)
        pg.screenshot(path=f'{OUT}/chain-{tag}-1-connect.png')
        pg.click('[data-act=injected]'); pg.wait_for_timeout(800)
        pg.screenshot(path=f'{OUT}/chain-{tag}-2-wrong-network.png')
        pg.click('[data-act=switch][data-id="31337"]'); pg.wait_for_selector('[data-act=sign]'); pg.wait_for_timeout(1500)
        pg.click('[data-act=sign]'); pg.wait_for_selector('text=Signed in')
        pg.click('[data-act=faucet]'); pg.wait_for_function("document.body.innerText.includes('Faucet: confirmed')", timeout=30000); pg.wait_for_timeout(500)
        pg.fill('#cAmt', '1000'); pg.click('[data-act=deposit]'); pg.wait_for_function("document.body.innerText.includes('Deposit: confirmed')", timeout=60000); pg.wait_for_timeout(9000)
        pg.screenshot(path=f'{OUT}/chain-{tag}-3-deposited.png', full_page=True)
        # 10x long 50
        pg.fill('#cMargin', '50'); pg.fill('#cLev', '10'); pg.dispatch_event('#cLev', 'input'); pg.click('[data-act=open]')
        pg.wait_for_function("document.querySelectorAll('#chainpanel .tbl tr').length>=2", timeout=90000)
        pg.wait_for_function("document.body.innerText.includes('Open: confirmed')", timeout=30000); pg.wait_for_timeout(2500)
        if tag == 'mobile':
            pg.fill('#cLev', '10000'); pg.dispatch_event('#cLev', 'input')
            pg.screenshot(path=f'{OUT}/chain-{tag}-4-10000x-warning.png', full_page=True)
            pg.goto('http://localhost:8091/?dev=1'); pg.wait_for_timeout(2500)
            pg.screenshot(path=f'{OUT}/chain-{tag}-8-simulator-mode.png'); continue
        # 10000x short margin 5
        pg.wait_for_timeout(1000); pg.click('#cSide [data-s=short]'); pg.fill('#cMargin', '5'); pg.fill('#cLev', '10000'); pg.dispatch_event('#cLev', 'input')
        pg.screenshot(path=f'{OUT}/chain-{tag}-4-10000x-warning.png', full_page=True)
        pg.click('[data-act=open]'); pg.wait_for_timeout(2500)
        try: pg.wait_for_function("document.querySelectorAll('#chainpanel .tbl tr').length>=3", timeout=40000)
        except Exception: print('TOASTS', pg.evaluate("[...document.querySelectorAll('.ctoast')].map(t=>t.textContent)")); raise
        pg.wait_for_timeout(9500)
        pg.screenshot(path=f'{OUT}/chain-{tag}-5-positions.png', full_page=True)
        if tag == 'desktop':
            subprocess.run(['pkill', '-f', 'node price-relayer'])
            orc = json.load(open('/workspace/p10k-wt/deployments.local.json'))['31337']['oracle']
            subprocess.Popen(['node', 'price-relayer.mjs', '--interval', '3', '--fixed', 'BTC=100100,ETH=3500'], cwd='/workspace/p10k-wt/tools', stdout=open('/tmp/relayer.log', 'w'), stderr=subprocess.STDOUT,
                env={**os.environ, 'RELAYER_KEY': subprocess.check_output([os.path.expanduser('~/.foundry/bin/cast'), 'wallet', 'private-key', 'test test test test test test test test test test test junk', '0']).decode().strip(), 'ORACLE': orc, 'RPC': RPC, 'CHAIN_ID': '31337'})
            time.sleep(12); pg.wait_for_function("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Liquidate'))", timeout=40000)
            pg.screenshot(path=f'{OUT}/chain-{tag}-6-liquidatable.png', full_page=True)
            pg.click('text=Liquidate (anyone)'); pg.wait_for_function("document.body.innerText.includes('Liquidate: confirmed')", timeout=60000); pg.wait_for_timeout(10000)
            pg.screenshot(path=f'{OUT}/chain-{tag}-7-liquidated-px.png', full_page=True)
            print('PX bal text:', pg.inner_text('#chainpanel').split('PAPER10KX (no value)')[1][:40].replace('\n', ' '))
        pg.goto('http://localhost:8091/?dev=1'); pg.wait_for_timeout(2500)
        pg.screenshot(path=f'{OUT}/chain-{tag}-8-simulator-mode.png')
    b.close()
print('errors:', errs)
