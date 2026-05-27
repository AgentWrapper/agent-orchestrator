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
      { threshold: 0.1, rootMargin: "-40px" }
    );

    // Observe both landing-reveal and stagger-children elements
    document.querySelectorAll(".landing-reveal, .stagger-children").forEach((el) => {
      observer.observe(el);
    });

    return () => observer.disconnect();
  }, []);

  return <>{children}</>;
}
