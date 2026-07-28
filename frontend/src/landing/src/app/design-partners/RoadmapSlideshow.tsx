"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import { useState } from "react";

export type RoadmapPhase = {
  num: string;
  status: string;
  title: string;
  theme: string;
  unlocks: string[];
  image: string;
  imageAlt: string;
};

export function RoadmapSlideshow({
  phases,
}: {
  phases: RoadmapPhase[];
}) {
  // `openIndex` drives the accordion and can be null so the open row closes on a
  // second click. `imageIndex` never goes null — the illustration keeps showing
  // the phase you last touched.
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const [imageIndex, setImageIndex] = useState(0);
  const shouldReduceMotion = useReducedMotion();
  const activePhase = phases[imageIndex];

  const togglePhase = (index: number) => {
    setImageIndex(index);
    setOpenIndex((current) => (current === index ? null : index));
  };

  return (
    <div className="grid overflow-hidden rounded-xl border border-border lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="lg:border-r lg:border-border">
        {phases.map((phase, index) => {
          const isOpen = index === openIndex;
          const panelId = `roadmap-panel-${phase.num}`;

          return (
            <div key={phase.title} className="border-b border-border">
              <button
                type="button"
                onClick={() => togglePhase(index)}
                aria-expanded={isOpen}
                aria-controls={panelId}
                className="group min-h-14 w-full px-4 py-5 text-left transition-[background-color] duration-150 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:px-6"
              >
                <span className="flex items-start gap-4">
                  <span className="mt-1 w-6 shrink-0 text-xs font-medium text-muted-foreground">
                    {phase.num}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start justify-between gap-4">
                      <span className="text-lg font-medium tracking-[-0.5px] text-foreground">
                        {phase.title}
                      </span>
                      <span
                        aria-hidden="true"
                        className="relative mt-2 flex h-3 w-3 shrink-0 items-center justify-center"
                      >
                        <span
                          className={`block h-px w-3 bg-foreground transition-transform duration-200 ${
                            isOpen ? "rotate-0" : "rotate-90"
                          }`}
                        />
                        <span className="absolute block h-px w-3 bg-foreground" />
                      </span>
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {phase.status}
                    </span>
                  </span>
                </span>
              </button>

              <AnimatePresence initial={false}>
                {isOpen ? (
                  <motion.div
                    id={panelId}
                    key="details"
                    initial={
                      shouldReduceMotion ? false : { height: 0, opacity: 0 }
                    }
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={
                      shouldReduceMotion
                        ? { duration: 0 }
                        : {
                            height: {
                              duration: 0.3,
                              ease: [0.2, 0, 0, 1],
                            },
                            opacity: { duration: 0.2 },
                          }
                    }
                    className="overflow-hidden"
                  >
                    <div className="pb-5 pl-14 pr-4 lg:h-[17rem] lg:pl-16 lg:pr-10">
                      <div className="max-w-lg text-sm leading-7 text-muted-foreground">
                        {phase.theme}
                      </div>
                      <div className="mt-5 space-y-3 border-l border-border pl-5">
                        {phase.unlocks.map((unlock) => (
                          <div
                            key={unlock}
                            className="text-sm leading-6 text-muted-foreground"
                          >
                            {unlock}
                          </div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      <div className="relative min-h-[18rem] overflow-hidden border-t border-border bg-black sm:min-h-[30rem] lg:min-h-[38rem] lg:border-t-0">
        <AnimatePresence initial={false} mode="wait">
          <motion.figure
            key={activePhase.image}
            initial={
              shouldReduceMotion
                ? false
                : { opacity: 0, y: 12, filter: "blur(4px)" }
            }
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -8, filter: "blur(3px)" }}
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { duration: 0.22, ease: [0.2, 0, 0, 1] }
            }
            className="absolute inset-0"
          >
            <Image
              src={activePhase.image}
              alt={activePhase.imageAlt}
              fill
              sizes="(max-width: 1024px) 100vw, 55vw"
              className="object-contain"
            />
          </motion.figure>
        </AnimatePresence>
      </div>
    </div>
  );
}
