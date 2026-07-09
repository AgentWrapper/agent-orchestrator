// Static image imports (Metro resolves these to an asset reference at runtime,
// which React Native's <Image source> accepts as a number).
declare module "*.png" {
	const content: number;
	export default content;
}

// Global CSS imports (Metro supports them on web; native never sees the
// importing file because only *.web.tsx imports CSS).
declare module "*.css";
