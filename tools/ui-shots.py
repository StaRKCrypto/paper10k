# Screenshots of the 10kx redesign at 1440 and 390. Needs `python3 -m http.server 8093` in repo root.
import os
from playwright.sync_api import sync_playwright
OUT = os.environ.get('SHOTS', '/workspace/paper10k-shots'); os.makedirs(OUT, exist_ok=True)
URL = os.environ.get('URL', 'http://localhost:8093/'); errs = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for w, h, tag in [(1440, 900, '1440'), (390, 844, '390')]:
        pg = b.new_context(viewport={'width': w, 'height': h}).new_page()
        pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'ERR_' not in m.text and 'Failed to load' not in m.text else None)
        pg.goto(URL + '#home'); pg.wait_for_function("document.querySelector('#feedPill').textContent.includes('live')", timeout=30000); pg.wait_for_timeout(3500)
        pg.screenshot(path=f'{OUT}/ui-{tag}-1-landing.png')
        if tag == '390': pg.screenshot(path=f'{OUT}/ui-{tag}-1b-landing-full.png', full_page=True)
        pg.click('#goTrade'); pg.wait_for_timeout(1500)
        pg.screenshot(path=f'{OUT}/ui-{tag}-2-trade.png')
        pg.fill('#margin', '50'); pg.fill('#levNum', '100'); pg.dispatch_event('#levNum', 'input'); pg.click('#submit'); pg.wait_for_timeout(2000)
        pg.screenshot(path=f'{OUT}/ui-{tag}-3-trade-position.png', full_page=(tag == '390'))
        pg.evaluate("document.querySelector('#modal').hidden=true")
        pg.click('#navLinks [data-go=lp]'); pg.wait_for_timeout(1500); pg.screenshot(path=f'{OUT}/ui-{tag}-4-house.png')
        pg.click('#navLinks [data-go=chain]'); pg.wait_for_timeout(1200); pg.screenshot(path=f'{OUT}/ui-{tag}-5-onchain-testnet.png', full_page=(tag == '390'))
        print(tag, 'banner:', pg.inner_text('#simbar')[:70], '| pill:', pg.inner_text('#netPill'))
    b.close()
print('errors:', errs)
