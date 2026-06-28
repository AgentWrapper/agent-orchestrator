import { LandingNav } from "../../components/LandingNav";
import { LandingHero } from "../../components/LandingHero";
import { LandingAgentsBar } from "../../components/LandingAgentsBar";
import { LandingVideo } from "../../components/LandingVideo";
import { LandingFeatures } from "../../components/LandingFeatures";
import { LandingHowItWorks } from "../../components/LandingHowItWorks";
import { LandingArchitecture } from "../../components/LandingArchitecture";
import { LandingLiveDemo } from "../../components/LandingLiveDemo";
import { LandingSocialProof } from "../../components/LandingSocialProof";
import { LandingCTA } from "../../components/LandingCTA";
import { LandingFooter } from "../../components/LandingFooter";
import { ScrollRevealProvider } from "../../components/ScrollRevealProvider";

export default function LandingPage() {
	return (
		<ScrollRevealProvider>
			<div className="relative z-10">
				<LandingNav />
				<LandingHero />
				<LandingAgentsBar />
				<LandingVideo />
				<LandingFeatures />
				<LandingHowItWorks />
				<LandingArchitecture />
				<LandingLiveDemo />
				<LandingSocialProof />
				<LandingCTA />
				<LandingFooter />
			</div>
		</ScrollRevealProvider>
	);
}
