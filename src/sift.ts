import * as fs from "fs";
import * as path from "path";
import * as postcss from 'postcss';
import * as puppeteer from 'puppeteer';
import type { Protocol } from 'devtools-protocol';

import { Arguments } from './bin/cli'

export async function sift(args: Arguments): Promise<void> {
    const browser = await puppeteer.launch({
        // headless:false,
        args: [
            '--window-size=1400,1080',
        ],
    });

    const page = await browser.newPage()

    // Setup Chrome DevTools protocol client
    const cdpClient = (await page.target().createCDPSession());
    await cdpClient.send('Page.enable')
    await cdpClient.send('DOM.enable')
    await cdpClient.send('CSS.enable')

    const styleSheetHeaders: { [key: string]: Protocol.CSS.CSSStyleSheetHeader } = {};
    cdpClient.on('CSS.styleSheetAdded', async (event: Protocol.CSS.StyleSheetAddedEvent) => {
        styleSheetHeaders[event.header.styleSheetId] = event.header;
    });

    await cdpClient.send('CSS.startRuleUsageTracking')
    await page.goto(args.url);

    // Scale viewport to capture media queries
    if (args.scaleViewport) {
        let width = 1400
        while (width > 0) {
            await page.setViewport({width: width, height: 1080});
            width -= 100;
        }
    }

    const styleSheetData: { [key: string]: string } = {};

    // Get coverage
    const usedStyleSheetIds: Set<string> = new Set()
    const ruleByStartID: { [key: string]: Protocol.CSS.RuleUsage } = {};

    const delta = await cdpClient.send('CSS.takeCoverageDelta') as Protocol.CSS.TakeCoverageDeltaResponse;
    const coverage = delta.coverage.filter((r) => r.used);
    for (const rule of coverage) {
        usedStyleSheetIds.add(rule.styleSheetId);

        // Fetch stylesheet data if needed
        if (!(rule.styleSheetId in styleSheetData)) {
            const resp = await cdpClient.send('CSS.getStyleSheetText', {styleSheetId: rule.styleSheetId}) as Protocol.CSS.GetStyleSheetTextResponse;
            styleSheetData[rule.styleSheetId] = resp.text;
        }

        const charRange = ruleToCharRange(rule, styleSheetData[rule.styleSheetId])
        const startID = `${rule.styleSheetId}:${charRange.start?.line}:${charRange.start?.column}`
        ruleByStartID[startID] = rule
    }

    const outData: { [key: string]: Array<string> } = {};

    // Fetch stylesheet data for used rules
    const syntaxTrees: { [key: string]: postcss.Root } = {};
    for (const styleSheetId of usedStyleSheetIds) {
        const resp = await cdpClient.send('CSS.getStyleSheetText', {styleSheetId: styleSheetId}) as Protocol.CSS.GetStyleSheetTextResponse;
        const ast = postcss.parse(resp.text);
        syntaxTrees[styleSheetId] = ast;

        // Walk it
        ast.walkRules((r) => {
            const startID = `${styleSheetId}:${r.source?.start?.line}:${r.source?.start?.column}`
            if (startID in ruleByStartID) {
                if (!(styleSheetId in outData)) {
                    outData[styleSheetId] = [];
                }
                outData[styleSheetId].push(ruleToString(r))
            }
        })
    }

    for (const styleSheetId in outData) {
        const data = outData[styleSheetId].join('\n')
        const sourceUrl = new URL(styleSheetHeaders[styleSheetId].sourceURL)

        if (args.outDir) {
            let outFile = args.outDir.replace(/\/$/, '') + sourceUrl.pathname

            const basename = path.basename(outFile)
            const dir = outFile.replace(basename, '')
            outFile = dir + basename.substr(0, basename.indexOf(".")) + args.outExt;

            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, {recursive: true})
            }

            fs.writeFileSync(outFile, data)
        } else {
            console.log('// ' + sourceUrl.toString())
            console.log(data)
        }
    }

    await page.close();
    await browser.close();
}


declare module "postcss" {
    interface Input {
        css: string
    }
}

interface charID {
    line: number;
    column: number;
}

interface charRange {
    start?: charID
    end?: charID
}

function ruleToCharRange(rule: Protocol.CSS.RuleUsage, styleSheetData: string): charRange {
    let cursor = 0;
    let lineNum = 1;
    const range: charRange = {};

    for (const line of styleSheetData.split('\n')) {
        if (!range.start && cursor + line.length >= rule.startOffset) {
            range.start = {
                line: lineNum,
                column: rule.startOffset - cursor + 1
            }
        }

        if (cursor + line.length >= rule.endOffset) {
            range.end = {
                line: lineNum,
                column: rule.endOffset - cursor
            }
            break;
        }

        cursor += line.length + 1; // include newline character
        lineNum++;
    }

    return range
}

function ruleToString(rule: postcss.Rule): string {
    if (rule.parent instanceof postcss.AtRule && rule.parent.name == 'media') {
        return rule.parent.toString()
    }
    return rule.toString()
}
