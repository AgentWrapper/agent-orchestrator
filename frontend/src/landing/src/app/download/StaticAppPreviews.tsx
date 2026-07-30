import { MobileAppDemo } from "../components/FeaturesSection/components/MobileAppDemo/MobileAppDemo";
import { AppMockup } from "../components/HeroSection/components/AppMockup";

export function DesktopAppPreview() {
  return (
    <div className="absolute left-6 top-6 h-[360px] w-[1032px]">
      <AppMockup />
    </div>
  );
}

export function PhoneAppPreview() {
  return (
    <div className="absolute inset-0 flex items-start justify-center pt-6">
      <MobileAppDemo />
    </div>
  );
}
