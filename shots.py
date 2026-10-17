import sys, time, json
from playwright.sync_api import sync_playwright
OUT='/workspace/paper10k-shots'; errs=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    for w,h,tag in [(1440,900,'1440'),(390,844,'390')]:
        ctx=b.new_context(viewport={'width':w,'height':h}, device_scale_factor=1)
        pg=ctx.new_page()
        pg.on('console',lambda m,t=tag: errs.append((t,m.type,m.text)) if m.type in('error','warning') else None)
        pg.on('pageerror',lambda e,t=tag: errs.append((t,'pageerror',str(e))))
        pg.goto('http://localhost:8080/'); pg.wait_for_function("document.querySelector('#feedPill').textContent.includes('live')",timeout=30000)
        pg.wait_for_timeout(2500)
        pg.screenshot(path=f'{OUT}/{tag}-1-home.png')
        pg.click('#heroClose'); pg.wait_for_timeout(500)
        pg.screenshot(path=f'{OUT}/{tag}-2-trade.png')
        # open 100x long, $50
        pg.fill('#margin','50'); pg.fill('#levNum','100'); pg.dispatch_event('#levNum','input'); pg.click('#submit'); pg.wait_for_timeout(2500)
        pg.locator('#tabBody').scroll_into_view_if_needed()
        pg.screenshot(path=f'{OUT}/{tag}-3-position.png', full_page=(tag=='390'))
        print(tag,'positions:',pg.evaluate("JSON.parse(localStorage['paper10k.v1']).positions.length"))
        # liquidation: 10000x
        pg.evaluate("document.querySelector('#modal').hidden=true")
        pg.click('.mrow[data-s="DOGE"]'); pg.wait_for_timeout(1500)
        pg.fill('#margin','2'); pg.fill('#levNum','10000'); pg.dispatch_event('#levNum','input'); pg.click('#submit')
        pg.click('#sideSeg [data-s=short]'); pg.click('#submit')
        pg.wait_for_function("!document.querySelector('#modal').hidden",timeout=300000)
        pg.wait_for_timeout(900)
        pg.screenshot(path=f'{OUT}/{tag}-4-liquidation.png')
        print(tag,'liquidations:',pg.evaluate("JSON.parse(localStorage['paper10k.v1']).liquidations"))
        ctx.close()
    b.close()
print(json.dumps(errs,indent=1)); print('ERRS',len(errs))
