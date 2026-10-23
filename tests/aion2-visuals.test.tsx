// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AionBoards } from "@/components/aion2-board-map";
import { AionAsset, aionBoardNodeIcon, aionClassEmblem, aionImageSource } from "@/components/aion2-asset";
import type { AionBoard, AionBoardComparison } from "@/lib/aion2-types";

afterEach(cleanup);
const board: AionBoard = { id: 11, name: "Nezekan", openNodes: 1, totalNodes: 3, nodes: [
  { id: 1, row: 0, col: 0, name: "Start", kind: "Start", grade: "Common", unlocked: true, effects: ["Starting node"], icon: null },
  { id: 2, row: 0, col: 1, name: "Attack", kind: "Stat", grade: "Common", unlocked: false, effects: ["Attack +5"], icon: null },
  { id: 3, row: 0, col: 2, name: "Overhead Slam", kind: "Skill", grade: "Legend", unlocked: false, effects: ["Overhead Slam +1"], icon: "https://assets.playnccdn.com/static-aion2-gamedata/resources/skill.png" },
] };
const plan: AionBoardComparison = { boardId: 11, label: "Gladiator PvE: skills first", source: "https://aion2.gg/en/calculator/daevanion", targets: [{ nodeId: 3, reason: "Adds a level to your main active skill." }], pathNodeIds: [1,2,3], missingNodeIds: [2,3], cost: 4, nodeCosts: [{ nodeId: 2, cost: 1 }, { nodeId: 3, cost: 3 }], notices: ["A reviewed progression preset."] };

it("shows sourced preset targets, the additional route cost and the selected target’s effects", () => {
  const view = render(<AionBoards boards={[board]} plans={[plan]} />);
  expect(screen.getByText("Gladiator PvE: skills first")).toBeTruthy();
  expect(screen.getByText(/Additional crystals \(route estimate\): 4/)).toBeTruthy();
  expect(view.container.querySelectorAll('[data-board-connection="reviewed"]')).toHaveLength(2);
  const target = screen.getByRole("button", { name: /Overhead Slam, locked, preset target, suggested route/ });
  expect(target.getAttribute("aria-pressed")).toBe("true");
  const detail = within(screen.getByRole("region", { name: "Selected node details" }));
  expect(detail.getByText("Overhead Slam +1")).toBeTruthy();
  expect(detail.getByText(/Adds a level to your main active skill/)).toBeTruthy();
  expect(detail.getByRole("img", { name: "Overhead Slam icon" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Compare preset" }));
  expect(screen.queryByRole("button", { name: /preset target/ })).toBeNull();
  expect(detail.queryByText(/Why this preset targets it/)).toBeNull();
});

it("keeps unverified or unavailable preset graphs free of invented connections", () => {
  const view = render(<AionBoards boards={[board]} />);
  expect(view.container.querySelectorAll('[data-board-connection="reviewed"]')).toHaveLength(0);
  expect(screen.getByText(/No reviewed preset is available/)).toBeTruthy();
  view.rerender(<AionBoards boards={[board]} plans={[{ ...plan, cost: null }]} />);
  expect(view.container.querySelectorAll('[data-board-connection="reviewed"]')).toHaveLength(0);
  view.rerender(<AionBoards boards={[{ ...board, id: 15 }]} plans={[{ ...plan, boardId: 15 }]} />);
  expect(view.container.querySelectorAll('[data-board-connection="reviewed"]')).toHaveLength(0);
});

it("keeps current nodes visible while stale source status withholds the comparison", () => {
  const view = render(<AionBoards boards={[board]} plans={[plan]} planNotice="Recommendations are withheld because the source review has expired." />);
  expect(screen.getByRole("group", { name: "Nezekan node map" })).toBeTruthy();
  expect(screen.queryByText("Gladiator PvE: skills first")).toBeNull();
  expect(screen.queryByRole("button", { name: "Compare preset" })).toBeNull();
  expect(view.container.querySelectorAll('[data-board-connection="reviewed"]')).toHaveLength(0);
});

it("supports node selection, keyboard movement and zoom without changing character state", () => {
  render(<AionBoards boards={[board]} plans={[plan]} />);
  fireEvent.click(screen.getByRole("button", { name: /Start, unlocked, suggested route/ }));
  expect(within(screen.getByRole("region", { name: "Selected node details" })).getByText("Unlocked")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("button", { name: /Start, unlocked, suggested route/ }), { key: "ArrowRight" });
  expect(within(screen.getByRole("region", { name: "Selected node details" })).getByText("Attack +5")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in board" }));
  expect(screen.getByRole("group", { name: "Nezekan node map" }).style.width).toBe("125%");
  fireEvent.click(screen.getByRole("button", { name: "Fit board" }));
  expect(screen.getByRole("group", { name: "Nezekan node map" }).style.width).toBe("100%");
});

it("shows the ordered connector nodes and individual costs from the reviewed plan", () => {
  render(<AionBoards boards={[board]} plans={[plan]} />);
  const order = within(screen.getByRole("list", { name: "Suggested node unlock order" }));
  const buttons = order.getAllByRole("button");
  expect(buttons).toHaveLength(2);
  expect(buttons[0].textContent).toContain("1Attack");
  expect(buttons[1].textContent).toContain("2Overhead Slam");
  expect(order.getByText("1 crystal")).toBeTruthy();
  expect(order.getByText("3 crystals")).toBeTruthy();
  fireEvent.click(buttons[0]);
  expect(within(screen.getByRole("region", { name: "Selected node details" })).getByText("Attack +5")).toBeTruthy();
});

it("does not treat a free starting node as a missing paid unlock", () => {
  const current = { ...board, nodes: board.nodes!.map(n => n.id === 1 ? { ...n, unlocked: false } : n) };
  render(<AionBoards boards={[current]} plans={[plan]} />);
  fireEvent.click(screen.getByRole("button", { name: /Start, free start, suggested route/ }));
  expect(within(screen.getByRole("region", { name: "Selected node details" })).getByText("Free starting node")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Suggested node unlock order" })).getAllByRole("button")).toHaveLength(2);
});

it("uses only public image hosts and recovers to a fallback when an icon fails", () => {
  expect(aionImageSource("https://assets.playnccdn.com/static-aion2-gamedata/resources/skill.png")).toBe(true);
  expect(aionImageSource("https://assets.playnccdn.com.attacker.test/icon.png")).toBe(false);
  expect(aionImageSource("https://user:pass@assets.playnccdn.com/icon.png")).toBe(false);
  expect(aionImageSource("javascript:alert(1)")).toBe(false);
  const view = render(<AionAsset src="https://assets.playnccdn.com/icon.png" alt="Example item" />);
  fireEvent.error(screen.getByRole("img", { name: "Example item" }));
  expect(screen.queryByRole("img", { name: "Example item" })).toBeNull();
  view.rerender(<AionAsset src="https://assets.playnccdn.com/new-icon.png" alt="New item" />);
  expect(screen.getByRole("img", { name: "New item" })).toBeTruthy();
});

it("replaces failed SVG icon URLs with text across the board and only attempts changed URLs", () => {
  const brokenUrl = "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_legend.png";
  const current = { ...board, nodes: board.nodes!.map(node => node.id === 1 ? node : { ...node, grade: "Legend", icon: "https://assets.playnccdn.com/static-aion2-gamedata/resources/UT_FWindow_Daevanion_Node_Legend_Sprite.png" }) };
  const view = render(<AionBoards boards={[current]} plans={[plan]} />);
  expect(view.container.querySelectorAll("svg image")).toHaveLength(2);
  fireEvent.error(view.container.querySelector("svg image")!);
  expect(view.container.querySelectorAll("svg image")).toHaveLength(0);
  expect(screen.getByRole("button", { name: /Overhead Slam, locked, preset target/ }).querySelector("text")?.textContent).toBe("S");
  view.rerender(<AionBoards boards={[{ ...current }]} plans={[plan]} />);
  expect(view.container.querySelectorAll("svg image")).toHaveLength(0);
  const nextUrl = "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_legend_open.png";
  view.rerender(<AionBoards boards={[{ ...current, nodes: current.nodes!.map(node => node.id === 3 ? { ...node, unlocked: true } : node) }]} plans={[plan]} />);
  expect(view.container.querySelectorAll("svg image")).toHaveLength(1);
  expect(view.container.querySelector("svg image")?.getAttribute("href")).toBe(nextUrl);
  expect(view.container.querySelector(`svg image[href="${brokenUrl}"]`)).toBeNull();
});

it("resolves exact official armory grade/open images instead of broken API sprite names", () => {
  const base = "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/";
  for (const grade of ["Common", "Rare", "Legend", "Unique"]) {
    const node = { ...board.nodes![1], grade, icon: `https://assets.playnccdn.com/static-aion2-gamedata/resources/UT_FWindow_Daevanion_Node_${grade}_Sprite.png` };
    expect(aionBoardNodeIcon({ ...node, unlocked: false }, "Gladiator")).toBe(`${base}board_icon_${grade.toLowerCase()}.png`);
    expect(aionBoardNodeIcon({ ...node, unlocked: true }, "Gladiator")).toBe(`${base}board_icon_${grade.toLowerCase()}_open.png`);
  }
  expect(aionBoardNodeIcon(board.nodes![0], "Gladiator")).toBe(`${base}board_icon_start_gladiator.png`);
  expect(aionClassEmblem("Spiritmaster")).toBe(`${base}board_icon_start_elementalist.png`);
  expect(aionClassEmblem("constructor")).toBeNull();
  expect(aionClassEmblem("__proto__")).toBeNull();
  expect(aionClassEmblem("Unreviewed class")).toBeNull();
  expect(aionBoardNodeIcon({ ...board.nodes![1], grade: "Unknown", icon: "https://assets.playnccdn.com/static-aion2-gamedata/resources/UT_FWindow_Daevanion_Node_Unknown_Sprite.png" })).toBeNull();
});

it("renders the actual class emblem and gives the next unlock a distinct route marker", () => {
  const view = render(<AionBoards boards={[board]} plans={[plan]} characterClass="Gladiator" />);
  expect(screen.getByRole("img", { name: "Gladiator Daevanion emblem" }).getAttribute("src")).toContain("board_icon_start_gladiator.png");
  expect(view.container.querySelector('svg image[href$="board_icon_start_gladiator.png"]')).toBeTruthy();
  expect(view.container.querySelector('svg image[href$="board_icon_common.png"]')).toBeTruthy();
  expect(view.container.querySelector('svg image[href$="board_icon_legend.png"]')).toBeTruthy();
  expect(view.container.querySelector('svg image[href*="UT_FWindow"]')).toBeNull();
  expect(screen.getByRole("button", { name: /Attack, locked, suggested route, next unlock/ }).getAttribute("data-node-next")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Compare preset" }));
  expect(view.container.querySelector('[data-node-next="true"]')).toBeNull();
});

it("keeps long preset notes and artwork provenance in clear optional folds", () => {
  render(<AionBoards boards={[board]} plans={[{ ...plan, notices: ["A detailed reviewed preset limitation."] }]} characterClass="Gladiator" />);
  const presetDetails = screen.getByText("Preset source & limits").closest("details") as HTMLDetailsElement;
  const artDetails = screen.getByText("Map controls & artwork").closest("details") as HTMLDetailsElement;
  expect(presetDetails.open).toBe(false); expect(artDetails.open).toBe(false);
  expect(within(presetDetails).getByText("A detailed reviewed preset limitation.")).toBeTruthy();
  expect(within(artDetails).getByRole("link", { name: "Official artwork reference" }).getAttribute("href")).toBe("https://assets.playnccdn.com/static-aion2/characters/css/index.css");
});
