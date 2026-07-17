import React from "react";
import { withTranslation, type WithTranslation } from "react-i18next";
import { captureRendererException } from "../lib/telemetry";

type Props = WithTranslation & {
	children: React.ReactNode;
};

type State = {
	hasError: boolean;
};

class TelemetryBoundaryImpl extends React.Component<Props, State> {
	state: State = { hasError: false };

	static getDerivedStateFromError() {
		return { hasError: true };
	}

	componentDidCatch(error: Error, info: React.ErrorInfo) {
		void captureRendererException(error, {
			source: "react-error-boundary",
			operation: "react_render",
		});
		void info;
	}

	render() {
		if (this.state.hasError) {
			const { t } = this.props;
			return (
				<div className="flex h-screen items-center justify-center bg-background px-6 text-center text-foreground">
					<div>
						<h1 className="text-heading-sm font-semibold">{t("shell.telemetry.title")}</h1>
						<p className="mt-2 text-sm text-muted-foreground">{t("shell.telemetry.detail")}</p>
					</div>
				</div>
			);
		}
		return this.props.children;
	}
}

export const TelemetryBoundary = withTranslation()(TelemetryBoundaryImpl);
