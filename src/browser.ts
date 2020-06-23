
import * as puppeteer from 'puppeteer';
import type { Protocol } from 'devtools-protocol';

export class BrowserClient {
    private browser?: puppeteer.Browser;
    private cdp?: puppeteer.CDPSession
    private page?: puppeteer.Page

    private browserConnectionInterval? : NodeJS.Timeout;
    private cssCoverageInterval?: NodeJS.Timeout;
    private cssCoverage: Protocol.CSS.RuleUsage[] = [];

    constructor(
        private headless = true,
        private width = 1400,
        private height = 1080,
    ) {}

    async start(): Promise<void> {
        this.browser = await puppeteer.launch({
            headless: this.headless,
            args: [`--window-size=${this.width},${this.height}`],
        });

        this.browserConnectionInterval = setInterval(async () => {
            if (!this.browser?.isConnected() || this.page?.isClosed()) {
                await this.stop()
            }
        }, 100);
    }

    async stop(): Promise<void> {
        if (this.browserConnectionInterval) {
            clearInterval(this.browserConnectionInterval);
        }
        this.browserConnectionInterval = undefined

        this.cdp = undefined
        await this.stopCSSRuleUsageTracking()

        try {
            await this.page?.close();
        } catch (e) {
            // Page already closed
        } finally {
            this.page = undefined;
        }

        try {
            await this.browser?.close();
        } catch (e) {
            // Browser already closed
        } finally {
            this.browser = undefined;
        }
    }

    async newPage(initializeDevtools = false): Promise<puppeteer.Page> {
        if (!this.browser) { throw Error('Must start browser client before opening page') }
        if (this.page) { throw Error('Currently the client only supports a single page open') }
        this.page = await this.browser.newPage()

        // Setup Chrome DevTools protocol client
        if (initializeDevtools) {
            this.cdp = await this.page.target().createCDPSession();
            await this.cdp.send('Page.enable')
            await this.cdp.send('DOM.enable')
            await this.cdp.send('CSS.enable')
        }

        return this.page;
    }

    async waitForDisconnect(): Promise<void> {
        if (!this.browser) { throw Error('There is no browser connected to wait for') }

        await new Promise((resolve) => {
            const i = setInterval(() => {
                if (!this.browserConnectionInterval) {
                    clearInterval(i);
                    resolve()
                }
            }, 100);
        });
    }

    onStyleSheetAdded(cb: (event: Protocol.CSS.StyleSheetAddedEvent) => void): void {
        this.cdp?.on('CSS.styleSheetAdded', (event: Protocol.CSS.StyleSheetAddedEvent) => {
            cb(event);
        });
    }

    async startCSSRuleUsageTracking(): Promise<void> {
        if (!this.cdp) { throw Error('Page must be devtools must be enabled for page') }
        await this.cdp.send('CSS.startRuleUsageTracking');
        this.cssCoverageInterval = setInterval(async () => {
            try {
                this.cssCoverage = (await this.getCSSCoverageDelta()).coverage;
            } catch (e) {
                if (this.cssCoverageInterval) {
                    clearInterval(this.cssCoverageInterval);
                }
                this.cssCoverageInterval = undefined;
            }
        }, 1000);
    }

    async stopCSSRuleUsageTracking(): Promise<Protocol.CSS.RuleUsage[]> {
        if (!this.cdp) { return this.cssCoverage; }
        this.cssCoverage = (await this.cdp.send('CSS.stopRuleUsageTracking') as Protocol.CSS.StopRuleUsageTrackingResponse).ruleUsage;
        if (this.cssCoverageInterval) {
            clearInterval(this.cssCoverageInterval);
        }
        this.cssCoverageInterval = undefined;
        return this.cssCoverage
    }

    async getStyleSheetText(stylesheetID: string): Promise<string> {
        if (!this.cdp) { throw Error('Page must be devtools must be enabled for page') }
        const resp = await this.cdp.send('CSS.getStyleSheetText', {styleSheetId: stylesheetID}) as Protocol.CSS.GetStyleSheetTextResponse;
        return resp.text;
    }

    private async getCSSCoverageDelta(): Promise<Protocol.CSS.TakeCoverageDeltaResponse> {
        if (!this.cdp) { throw Error('Must call startCSSRuleUsageTracking before getting a coverage delta') }
        return await this.cdp.send('CSS.takeCoverageDelta') as Protocol.CSS.TakeCoverageDeltaResponse;
    }
}
