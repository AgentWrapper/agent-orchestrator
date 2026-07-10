// Static image imports (Metro resolves these to an asset reference at runtime,
// which React Native's <Image source> accepts as a number).
declare module "*.png" {
	const content: number;
	export default content;
}
