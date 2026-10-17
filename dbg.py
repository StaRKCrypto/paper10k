from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox']); pg=b.new_page()
    pg.goto('http://localhost:8080/'); pg.wait_for_timeout(4000)
    pg.click('.mrow[data-s="DOGE"]'); pg.wait_for_timeout(1500)
    pg.fill('#margin','2'); pg.fill('#levNum','10000'); pg.dispatch_event('#levNum','input'); pg.click('#submit')
    pg.click('#sideSeg [data-s=short]'); pg.click('#submit')
    pg.wait_for_function("JSON.parse(localStorage['paper10k.v1']).history.length>0",timeout=200000)
    print(pg.evaluate("localStorage['paper10k.v1']"))
