---
name: social-media-posts
description: "Draft viral social media posts for X (Twitter) and LinkedIn. Use when asked to write, draft, create, or improve posts for X, Twitter, LinkedIn, or social media. Handles single posts, threads, milestone celebrations, product launches, hot takes, and engagement-optimized content. NOT for: scheduling posts, managing accounts, or analytics."
---

# Social Media Posts

Draft platform-optimized posts using the user's voice and style preferences.

## Voice Calibration

Before drafting, match the author's actual voice — not a generic "builder tone."

1. Ask the user for 3-5 reference posts they've written (or search past posts if available)
2. Extract: sentence length, vocabulary level, humor style, how they handle numbers, how they open/close
3. If no references available, default to: first person, direct, specific numbers, no corporate speak

Every author sounds different. "Builder tone" is the floor, not the ceiling.

## Platform Rules

### X (Twitter)
- Single post: max 280 chars (or up to ~600 if user has Premium)
- Thread: 1/ 2/ 3/ numbering, first tweet is the hook, last tweet is CTA
- First tweet must stand alone — it's what gets retweeted
- End thread with link + call to action
- No hashtags unless user asks (X algorithm deprioritizes them)
- Use line breaks for visual rhythm

#### X Media Strategy
Posts with media outperform text-only. Always consider:
- **Screenshots:** For dashboard/UI features — show, don't tell
- **GIFs/Demos:** For workflow changes — 5-10 second loops
- **4-image grid:** For multi-feature showcases — each image = one feature
- Reference media in-tweet: "↓ see it in action" or just let the image speak
- When a post needs a visual, use `image_generate` to create one — don't just describe it

#### Thread vs Single Post Decision
- **Single post:** One feature, one metric, one announcement, under 280 chars
- **Thread:** Multiple features, a story arc, technical breakdown, or anything that needs "and here's why"
- If you're cramming to fit 280 chars, it's probably a thread

### LinkedIn
- No character limit but sweet spot is 150-300 words
- **Hook character limit: ~210 chars before "see more" fold** — the entire hook MUST fit before the fold
- First line is everything — it's the "see more" hook
- Use Unicode bold (𝗯𝗼𝗹𝗱) for emphasis
- Section breaks: `— — —`
- Arrow bullets: `→` not `-`
- Max 2-3 hashtags, at the very end
- Short paragraphs (1-3 sentences max)
- **Blank lines matter** — double line break between paragraphs creates the visual rhythm that keeps people scrolling

#### LinkedIn Bold Text
Use Unicode bold for key phrases. Common mappings:

```
A=𝗔 B=𝗕 C=𝗖 D=𝗗 E=𝗘 F=𝗙 G=𝗚 H=𝗛 I=𝗜 J=𝗝 K=𝗞 L=𝗟 M=𝗠
N=𝗡 O=𝗢 P=𝗣 Q=𝗤 R=𝗥 S=𝗦 T=𝗧 U=𝗨 V=𝗩 W=𝗪 X=𝗫 Y=𝗬 Z=𝗭
a=𝗮 b=𝗯 c=𝗰 d=𝗱 e=𝗲 f=𝗳 g=𝗴 h=𝗵 i=𝗶 j=𝗷 k=𝗸 l=𝗹 m=𝗺
n=𝗻 o=𝗼 p=𝗽 q=𝗾 r=𝗿 s=𝘀 t=𝘁 u=𝘂 v=𝘃 w=𝘄 x=𝘅 y=𝘆 z=𝘇
0=𝟬 1=𝟭 2=𝟮 3=𝟯 4=𝟰 5=𝟱 6=𝟲 7=𝟳 8=𝟴 9=𝟵
```

Apply bold to:
- Opening stat/hook
- Section headers within post
- Key metrics
- Names/products being highlighted
- The punchline or key insight

Don't over-bold — if everything is bold, nothing is.

## Style Guide

### Voice
- Builder tone — someone who ships, not someone who advises
- First person, direct
- Confident but not arrogant
- Specific numbers over vague claims
- No corporate speak, no buzzword soup

### Banned Phrases
Never use these:
- "I'm thrilled/excited to announce"
- "Leveraging" / "Synergy"
- "Game-changer" / "Revolutionary"
- "Let's connect!" / "Thoughts?"
- "I'd love to hear your thoughts"
- Excessive emoji (1-2 max, only if natural)
- "🚀" as emphasis

## Hook Library

Don't start from scratch. Use these proven patterns:

### Stat-led hooks
- "We just hit [NUMBER] [metric]. Here's what actually moved the needle:"
- "[NUMBER]% of [audience] don't know [surprising fact]. We didn't either."
- "From [start] to [end] in [timeframe]. No funding, no team of 50."

### Contrarian hooks
- "Hot take: [contrarian position]. Here's why:"
- "Everyone says [common advice]. They're wrong. Here's what worked instead:"
- "Unpopular opinion: [bold claim]. And I have the data to back it up."

### Story hooks
- "Last [timeframe], [dramatic situation]. Today, [result]. Here's what happened:"
- "We [did something unexpected]. [Surprising outcome]."
- "[Number] [units] later, here's the one thing I wish I knew on day 1:"

### Product hooks
- "[Thing] just got [dramatic improvement]. [Before] → [After]:"
- "We open-sourced [thing]. [One-line what it does]. [Star/link]"
- "[Problem] is solved. Not partially. Actually solved. Here's how:"

## Structure Templates

### LinkedIn
1. Hook — bold stat, surprising claim, or punchy opener (1 line, under 210 chars)
2. Story — what happened, keep paragraphs short
3. Numbers — concrete metrics in arrow-bullet format
4. Insight — what you learned or what it means
5. CTA — link + next step (not "thoughts?")

### X Single Post
1. Hook line
2. Key details (2-3 lines)
3. Link

### X Thread
1. Hook + 🧵
2. Context/backstory
3. Numbers/details (1-2 tweets)
4. Turning point or insight
5. What's next + link

## CTA Library

Don't end with "thoughts?" — use CTAs that actually drive action:

### Repo/Product
- "Star the repo → [link]"
- "Try it: [one-line command]"
- "npm i -g [package] and see for yourself → [link]"

### Community
- "Join [number] builders in Discord → [link]"
- "What are you building? Drop it below 👇"

### Content
- "Full breakdown → [link]"
- "Read the docs → [link]"
- "Full release notes → [link]"

### Engagement
- "What's your [take/experience] with [topic]?"
- "RT if you've felt this pain ↓"

## Cross-Platform Adaptation

When the same content goes to both X and LinkedIn, restructure — don't just reformat:

| Aspect | X | LinkedIn |
|--------|---|----------|
| Length | Compressed, punchy | Story arc with whitespace |
| Narrative | Bullet points, rapid fire | Paragraphs, breathing room |
| Numbers | Inline, one per tweet | Arrow bullets, grouped |
| Hook | Shocking stat or hot take | Personal story or bold claim |
| CTA | Link only | Link + context |
| Formatting | Line breaks, no bold | Unicode bold, section breaks |

**Rule:** Write LinkedIn first (full story), then compress into X. Not the other way around — you can't expand a tweet into a story.

## Post Types

### Milestone Celebration (stars, users, revenue)
- Lead with the number
- Tell the journey (compressed)
- Show what was shipped
- Mention organic recognition
- What's next
- Keep it a story, not a press release

### Product Launch / Feature Ship
- What changed and why it matters
- Before → after (if applicable)
- One-line install/usage
- Link to repo or docs
- **Always attach a visual** — screenshot, GIF, or generated image

### Hot Take / Trend Response
- Acknowledge the trend
- State your position early
- Back it with what you've built
- Don't trash competitors — position yourself

### Article Promotion
- Pull the single most interesting insight
- Don't summarize the whole article
- Make people want to click
- Link at the end, not the beginning

## Output Format

Always output posts inside code blocks (```) so user can copy-paste directly.

For LinkedIn: single code block with the full post.
For X single: single code block.
For X thread: separate code blocks per tweet, numbered.

If the post needs a visual, generate it with `image_generate` and attach it.

## Checklist Before Delivering

- [ ] Hook line would make YOU stop scrolling
- [ ] No banned phrases
- [ ] Numbers are specific, not vague
- [ ] CTA is from the CTA library (not "thoughts?")
- [ ] Platform format is correct
- [ ] Under length limit
- [ ] LinkedIn hook fits under 210 chars (before "see more" fold)
- [ ] Reads like a human wrote it, not AI
- [ ] Visual attached or generated if post type warrants it (launch, milestone, feature)
