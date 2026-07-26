import { COMPANY } from "@superset/shared/constants";

export interface Testimonial {
  id: string;
  author: string;
  handle: string;
  avatar?: string;
  role?: string;
  content: string;
  originalContent?: string;
  url: string;
}

export const TESTIMONIALS: Testimonial[] = [
  {
    id: "teknium",
    author: "Teknium",
    handle: "@Teknium",
    content:
      'It can orchestrate agents but this looks a bit more advanced.',
    avatar: "https://unavatar.io/x/Teknium",
    url: "https://x.com/Teknium/status/2042318941457170790",
  },
  {
    id: "facito0",
    author: "FacitoO",
    handle: "@facito0",
    content:
      "Me with @aoagents lately!",
    avatar: "https://unavatar.io/x/facito0",
    url: "https://x.com/facito0/status/2036380796475547760",
  },
  {
    id: "buchireddy",
    author: "Buchi Reddy B",
    handle: "@buchireddy",
    content:
      "I really loved the building blocks present in @aoagents, hence we went all-in on that pretty early. Happy to share more details if it helps others.",
    avatar: "https://unavatar.io/x/buchireddy",
    url: "https://x.com/buchireddy/status/2064108144607760628",
  },
  {
    id: "adiiiie",
    author: "Adi",
    handle: "@addddiiie",
    content:
      "I just hired a few software devs to work for free cc, @aoagents",
    avatar: "https://unavatar.io/x/addddiiie",
    url: "https://x.com/addddiiie/status/2037174432700211408",
  },
  {
    id: "maria-garcia",
    author: "Maria Garcia",
    handle: "@maria_garcia_dev",
    content:
      "We run 50+ agents a day through AO. The feedback loop, CI fails go back to the agent that wrote the code, saves us hours every week.",
    url: "#",
  },
  {
    id: "luke-tanaka",
    author: "Luke Tanaka",
    handle: "@luke_tanaka",
    content:
      "The board view alone is worth the download. I can see every session, every PR, every CI status across all my repos in a single glance.",
    url: "#",
  },
  {
    id: "rachel-kim",
    author: "Rachel Kim",
    handle: "@rachelkim_eng",
    content:
      "The isolated worktree model is genius. No more merge conflict whack-a-mole when running multiple agents. Each one gets its own sandbox.",
    url: "#",
  },
];
