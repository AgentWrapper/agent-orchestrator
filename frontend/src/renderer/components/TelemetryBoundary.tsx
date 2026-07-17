import React from "react";
import { i18n } from "../i18n";
import { captureRendererException } from "../lib/telemetry";

type Props = {
	children: React.ReactNode;
};

type State = {
	hasError: boolean;
};

export class TelemetryBoundary extends React.Component<Props, State> {
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
			return (
				<div className="flex h-screen items-center justify-center bg-background px-6 text-center text-foreground">
					<div>
						<h1 className="text-heading-sm font-semibold">{i18n.t("shell.telemetry.title")}</h1>
						<p className="mt-2 text-sm text-muted-foreground">
							{i18n.t("shell.telemetry.detail")}
						</p>
					</div>
				</div>
			);
		}
		return this.props.children;
	}
}
