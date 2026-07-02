import { LandingNav } from "../../components/LandingNav";
import { LandingHero } from "../../components/LandingHero";
import { LandingAgentsBar } from "../../components/LandingAgentsBar";
import { LandingVideo } from "../../components/LandingVideo";
import { LandingFeatures } from "../../components/LandingFeatures";
import { LandingSocialProof } from "../../components/LandingSocialProof";
import { LandingFooter } from "../../components/LandingFooter";
import { ScrollRevealProvider } from "../../components/ScrollRevealProvider";

export default function LandingPage() {
	return (
		<ScrollRevealProvider>
			<div className="landing-page relative z-10 min-h-screen">
				<LandingNav />
				<LandingHero />
				<LandingAgentsBar />
				<LandingVideo />
				<LandingFeatures />
				<LandingSocialProof />
				<LandingFooter />
			</div>
		</ScrollRevealProvider>
	);
}
