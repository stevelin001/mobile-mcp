import path from "path";
import { execFileSync } from "child_process";

import * as xml from "fast-xml-parser";

import { ActionableError, Bounds, Button, Dimensions, ElementCoordinates, InstalledApp, Robot, SwipeDirection } from "./robot";

interface UiAutomatorXmlNode {
	node: UiAutomatorXmlNode[];
	text?: string;
	bounds?: string;
	"content-desc"?: string;
}

interface UiAutomatorXml {
	hierarchy: {
		node: UiAutomatorXmlNode;
	};
}

const getAdbPath = (): string => {
	let executable = "adb";
	if (process.env.ANDROID_HOME) {
		executable = path.join(process.env.ANDROID_HOME, "platform-tools", "adb");
	}

	return executable;
};

const BUTTON_MAP: Record<Button, string> = {
	"BACK": "KEYCODE_BACK",
	"HOME": "KEYCODE_HOME",
	"VOLUME_UP": "KEYCODE_VOLUME_UP",
	"VOLUME_DOWN": "KEYCODE_VOLUME_DOWN",
	"ENTER": "KEYCODE_ENTER",
};

const TIMEOUT = 30000;
const MAX_BUFFER_SIZE = 1024 * 1024 * 4;

export class AndroidRobot implements Robot {

	public constructor(private deviceId: string) {
	}

	public adb(...args: string[]): Buffer {
		return execFileSync(getAdbPath(), ["-s", this.deviceId, ...args], {
			maxBuffer: MAX_BUFFER_SIZE,
			timeout: TIMEOUT,
		});
	}

	public async getScreenSize(): Promise<Dimensions> {
		const screenSize = this.adb("shell", "wm", "size")
			.toString()
			.split(" ")
			.pop();

		if (!screenSize) {
			throw new Error("Failed to get screen size");
		}

		const [width, height] = screenSize.split("x").map(Number);
		return { width, height };
	}

	public async listApps(): Promise<InstalledApp[]> {
		return this.adb("shell", "cmd", "package", "query-activities", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("packageName="))
			.map(line => line.substring("packageName=".length))
			.filter((value, index, self) => self.indexOf(value) === index)
			.map(packageName => ({
				packageName,
				appName: packageName,
			}));
	}

	public async launchApp(packageName: string): Promise<void> {
		this.adb("shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1");
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const screenSize = await this.getScreenSize();
		const centerX = screenSize.width >> 1;
		// const centerY = screenSize[1] >> 1;

		let x0: number, y0: number, x1: number, y1: number;

		switch (direction) {
			case "up":
				x0 = x1 = centerX;
				y0 = Math.floor(screenSize.height * 0.80);
				y1 = Math.floor(screenSize.height * 0.20);
				break;
			case "down":
				x0 = x1 = centerX;
				y0 = Math.floor(screenSize.height * 0.20);
				y1 = Math.floor(screenSize.height * 0.80);
				break;
			default:
				throw new ActionableError(`Swipe direction "${direction}" is not supported`);
		}

		this.adb("shell", "input", "swipe", `${x0}`, `${y0}`, `${x1}`, `${y1}`, "1000");
	}

	public async getScreenshot(): Promise<Buffer> {
		return this.adb("shell", "screencap", "-p");
	}

	private collectElements(node: UiAutomatorXmlNode, screenSize: Dimensions): any[] {
		const elements: any[] = [];

		const getCoordinates = (element: UiAutomatorXmlNode): Bounds => {
			const bounds = String(element.bounds);

			const [, left, top, right, bottom] = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.map(Number) || [];
			return { left, top, right, bottom };
		};

		const getCenter = (coordinates: Bounds): ElementCoordinates => {
			return {
				x: Math.floor((coordinates.left + coordinates.right) / 2),
				y: Math.floor((coordinates.top + coordinates.bottom) / 2),
			};
		};

		const normalizeCoordinates = (coordinates: ElementCoordinates, screenSize: Dimensions): ElementCoordinates => {
			return {
				x: Number((coordinates.x / screenSize.width).toFixed(3)),
				y: Number((coordinates.y / screenSize.height).toFixed(3)),
			};
		};

		if (node.node) {
			if (Array.isArray(node.node)) {
				for (const childNode of node.node) {
					elements.push(...this.collectElements(childNode, screenSize));
				}
			} else {
				elements.push(...this.collectElements(node.node, screenSize));
			}
		}

		if (node.text) {
			elements.push({
				"text": node.text,
				"coordinates": normalizeCoordinates(getCenter(getCoordinates(node)), screenSize),
			});
		}

		if (node["content-desc"]) {
			elements.push({
				"text": node["content-desc"],
				"coordinates": normalizeCoordinates(getCenter(getCoordinates(node)), screenSize),
			});
		}

		return elements;
	}

	public async getElementsOnScreen(): Promise<any[]> {
		// 先保存到临时文件
		const tempFile = "/sdcard/window_dump.xml";
		this.adb("shell", "uiautomator", "dump", tempFile);
		
		// 读取文件内容并处理
		const rawContent = this.adb("shell", "cat", tempFile).toString();
		
		// 提取实际的XML内容
		const xmlStartIndex = rawContent.indexOf("<?xml");
		const xmlEndIndex = rawContent.lastIndexOf("</hierarchy>");
		
		if (xmlStartIndex === -1 || xmlEndIndex === -1) {
			throw new Error("Invalid XML content in dump file");
		}
		
		// 提取纯XML内容（包含结束标签）
		const xmlContent = rawContent.substring(xmlStartIndex, xmlEndIndex + "</hierarchy>".length);
		
		try {
			const parser = new xml.XMLParser({
				ignoreAttributes: false,
				attributeNamePrefix: ""
			});

			const parsedXml = parser.parse(xmlContent) as UiAutomatorXml;
			const screenSize = await this.getScreenSize();
			const elements = this.collectElements(parsedXml.hierarchy.node, screenSize);
			return elements;
		} catch (error: unknown) {
			console.error("XML parsing error:", error);
			throw new Error(`Failed to parse UI hierarchy: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	public async terminateApp(packageName: string): Promise<void> {
		this.adb("shell", "am", "force-stop", packageName);
	}

	public async openUrl(url: string): Promise<void> {
		this.adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url);
	}

	public async sendKeys(text: string): Promise<void> {
		// adb shell requires some escaping
		const _text = text.replace(/ /g, "\\ ");
		this.adb("shell", "input", "text", _text);
	}

	public async pressButton(button: Button) {
		if (!BUTTON_MAP[button]) {
			throw new ActionableError(`Button "${button}" is not supported`);
		}

		this.adb("shell", "input", "keyevent", BUTTON_MAP[button]);
	}

	public async tap(x: number, y: number): Promise<void> {
		this.adb("shell", "input", "tap", `${x}`, `${y}`);
	}
}

export const getConnectedDevices = (): string[] => {
	return execFileSync(getAdbPath(), ["devices"])
		.toString()
		.split("\n")
		.filter(line => !line.startsWith("List of devices attached"))
		.filter(line => line.trim() !== "")
		.map(line => line.split("\t")[0]);
};
