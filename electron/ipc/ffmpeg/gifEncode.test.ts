import { describe, expect, it } from "vitest";
import { buildGithubGifArgs } from "./gifEncode";

describe("buildGithubGifArgs", () => {
	it("builds a palettegen/paletteuse graph with even dimensions", () => {
		const args = buildGithubGifArgs("/tmp/in.mp4", "/tmp/out.gif", {
			width: 1281,
			height: 721,
			fps: 12,
			maxColors: 128,
			loop: true,
		});

		expect(args).toContain("/tmp/in.mp4");
		expect(args).toContain("/tmp/out.gif");
		expect(args).toContain("-loop");
		expect(args).toContain("0");

		const vfIndex = args.indexOf("-vf");
		const filter = args[vfIndex + 1];
		expect(filter).toContain("fps=12");
		expect(filter).toContain("scale=1280:720");
		expect(filter).toContain("palettegen=max_colors=128");
		expect(filter).toContain("paletteuse=dither=bayer");
	});

	it("uses loop=1 when looping is disabled", () => {
		const args = buildGithubGifArgs("/tmp/in.mp4", "/tmp/out.gif", {
			width: 640,
			height: 360,
			fps: 10,
			maxColors: 64,
			loop: false,
		});
		const loopIndex = args.indexOf("-loop");
		expect(args[loopIndex + 1]).toBe("1");
	});
});
