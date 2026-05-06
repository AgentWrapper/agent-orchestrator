"use client";

import { useEffect } from "react";

export function ScrollRevealProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
          }
        });
      },
      { threshold: 0.1, rootMargin: "-50px" }
    );

    document.querySelectorAll(".landing-reveal").forEach((el) => {
      observer.observe(el);
    });

    return () => observer.disconnect();
  }, []);

  return <>{children}</>;
}
