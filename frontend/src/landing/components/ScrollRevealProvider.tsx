"use client";

import { useEffect } from "react";

export function ScrollRevealProvider({ children }: { children: React.ReactNode }) {
	useEffect(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						entry.target.classList.add("visible");
						observer.unobserve(entry.target);
					}
				});
			},
			{ threshold: 0.12, rootMargin: "0px 0px -80px" },
		);

		document.querySelectorAll(".landing-reveal").forEach((el) => {
			observer.observe(el);
		});

		return () => observer.disconnect();
	}, []);

	return <>{children}</>;
}
