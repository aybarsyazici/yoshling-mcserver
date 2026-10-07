// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ModDetailDialog } from "@/components/mod-detail-dialog";
import { installBrowserStubs } from "./helpers/dom";

beforeAll(installBrowserStubs);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function description(body: string) {
  const detail = {
    title: "Description fixture", description: "Fabricated local project", body,
    icon_url: null, gallery: [], downloads: 1, followers: 1, categories: [], loaders: ["fabric"],
    game_versions: ["26.1.2"], license: "MIT", source_url: null, issues_url: null, wiki_url: null,
    discord_url: null, date_created: "2026-10-01T00:00:00Z", date_modified: "2026-10-06T00:00:00Z",
    client_side: "optional", server_side: "required",
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => detail })));
  render(<ModDetailDialog projectId="fixture" open onClose={() => {}} />);
  await screen.findByText(detail.title);
  await waitFor(() => { expect(document.querySelector(".prose")).not.toBeNull(); });
  const prose = document.querySelector(".prose");
  if (!prose) throw new Error("The description did not render");
  return prose;
}

// This exercises the real fetched-description component and rendering pipeline.
// jsdom does not execute embedded scripts here: the guarantee is dangerous nodes
// and attributes never reach the DOM, not a production-browser exploit result.
const PAYLOADS = [
  '<p>Visible safe text</p><iframe srcdoc="<script>window.parent.__fabricatedProbe=true</script>"></iframe>',
  'Markdown introduction\n\n<iframe srcdoc="<script>window.parent.__fabricatedProbe=true</script>"></iframe>\n\nVisible safe text',
  '<p>Visible safe text</p><script src="https://example.test/fixture.js"></script><script>window.__fabricatedProbe=true</script>',
  'Markdown introduction\n\n<script>window.__fabricatedProbe=true</script>\n\nVisible safe text',
  '<p onclick="window.__fabricatedProbe=true">Visible safe text</p><img alt="fixture" src="https://example.test/image.png" onerror="window.__fabricatedProbe=true"/>',
  'Markdown introduction\n\n<div onmouseover="window.__fabricatedProbe=true">Visible safe text</div>\n\n<img alt="fixture" src="https://example.test/image.png" onload="window.__fabricatedProbe=true"/>',
  '<p>Visible safe text</p><object data="https://example.test/fixture.html"></object><embed src="https://example.test/fixture.html"/><svg><foreignObject><iframe srcdoc="fixture"></iframe></foreignObject></svg>',
];

describe("untrusted mod description admission", () => {
  it.each(PAYLOADS.map((payload, index) => [index + 1, payload] as const))("blocks active content in description fixture %i", async (_index, payload) => {
    const prose = await description(payload);
    expect(prose.textContent).toContain("Visible safe text");
    expect(prose.querySelector("iframe, script, object, embed, foreignObject, [srcdoc]")).toBeNull();
    for (const element of prose.querySelectorAll("*")) {
      for (const attribute of element.attributes) expect(attribute.name).not.toMatch(/^on/i);
    }
  });

  it.each([
    '<p><a href="javascript:window.__fabricatedProbe=true">Dangerous link</a></p>',
    '<p><a href="jav&#x61;script:window.__fabricatedProbe=true">Dangerous link</a></p>',
    '<p><a href="data:text/html,fixture">Dangerous link</a></p>',
    '[Dangerous link](javascript:window.__fabricatedProbe=true)',
    'Markdown introduction\n\n<a href="javascript:window.__fabricatedProbe=true">Dangerous link</a>',
  ])("drops unsafe link URLs in HTML and Markdown", async (payload) => {
    const prose = await description(payload);
    const link = prose.querySelector("a")!;
    expect(link).not.toBeNull();
    expect(link.textContent).toContain("Dangerous link");
    expect(link.getAttribute("href")).toBeNull();
  });

  it("preserves safe HTML links, images, tables, code and protected fragment targets", async () => {
    const prose = await description('<h2 id="installation">Installation</h2><p><a href="#installation">Jump to installation</a> <a href="https://example.test/docs">Documentation</a></p><img src="https://example.test/diagram.png" alt="Safe diagram"/><table><thead><tr><th>Version</th></tr></thead><tbody><tr><td>26.1.2</td></tr></tbody></table><pre><code class="language-js">const version = "26.1.2";</code></pre>');
    expect(prose.querySelector("h2")?.id).toBe("user-content-installation");
    expect(prose.querySelector('a[href="#user-content-installation"]')?.textContent).toContain("Jump to installation");
    const link = prose.querySelector('a[href="https://example.test/docs"]')!;
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(prose.querySelector('img[alt="Safe diagram"]')?.getAttribute("src")).toBe("https://example.test/diagram.png");
    expect(prose.querySelector("table th")?.textContent).toBe("Version");
    expect(prose.querySelector("table td")?.textContent).toBe("26.1.2");
    expect(prose.querySelector("pre code")?.textContent).toBe('const version = "26.1.2";');
  });

  it("preserves Markdown links, images and fenced code plus embedded safe HTML tables", async () => {
    const prose = await description('## Installation\n\n[Documentation](https://example.test/docs)\n\n![Safe diagram](https://example.test/diagram.png)\n\n```js\nconst version = "26.1.2";\n```\n\n<table><tr><th>Version</th></tr><tr><td>26.1.2</td></tr></table>');
    expect(prose.querySelector("h2")?.textContent).toBe("Installation");
    expect(prose.querySelector('a[href="https://example.test/docs"]')).not.toBeNull();
    expect(prose.querySelector('img[alt="Safe diagram"]')?.getAttribute("src")).toBe("https://example.test/diagram.png");
    expect(prose.querySelector("pre code.language-js")?.textContent).toContain('const version = "26.1.2";');
    expect(prose.querySelector("table td")?.textContent).toBe("26.1.2");
  });
});
