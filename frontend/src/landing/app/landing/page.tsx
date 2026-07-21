import { LandingNav } from "../../components/LandingNav";
import { LandingHero } from "../../components/LandingHero";
import { LandingAgentsBar } from "../../components/LandingAgentsBar";
import { LandingVideo } from "../../components/LandingVideo";
import { LandingFeaturesShowcase } from "../../components/LandingFeaturesShowcase";
import { LandingInstall } from "../../components/LandingInstall";
import { LandingSocialProof } from "../../components/LandingSocialProof";
import { LandingCTA } from "../../components/LandingCTA";
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
				<LandingFeaturesShowcase />
				<LandingInstall />
				<LandingSocialProof />
				<LandingCTA />
				<LandingFooter />
			</div>
		</ScrollRevealProvider>
	);
}
