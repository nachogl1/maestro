---
layout: landing
title: Home
nav_order: 1
permalink: /
---

<section class="hero" aria-labelledby="hero-title">
  <canvas class="hero-canvas" aria-hidden="true"></canvas>
  <div class="wrap hero-inner">
    <figure class="hero-art">
      <img src="{{ '/assets/images/maestro-samurai.jpg' | relative_url }}" width="1600" height="800" alt="Maestro Samurai: a red samurai mask with glowing white eyes and two crossed katanas before a blood-red moon, with a torii gate, a pagoda and falling cherry-blossom petals, above the brush lettering MAESTRO SAMURAI." fetchpriority="high">
    </figure>
    <div class="hero-copy">
      <p class="eyebrow"><span class="dot"></span>Desktop app for Windows and macOS</p>
      <h1 id="hero-title">Many AI coding sessions.<br><span class="accent">One conductor.</span></h1>
      <p class="lede">Maestro puts every Claude Code terminal from every project on one screen, tells you the moment one of them needs you, and keeps the rest out of your way.</p>
      <div class="cta">
        <a class="btn btn-primary" href="https://github.com/nachogl1/maestro/releases/latest">Download for Windows <span class="ext">.msi</span></a>
        <a class="btn" href="https://github.com/nachogl1/maestro/releases/latest">Download for macOS <span class="ext">.dmg</span></a>
      </div>
      <p class="hint">Both buttons open the latest release. On Linux you build Maestro yourself: see <a href="{% link installation.md %}">Installation</a>.</p>
    </div>
  </div>
</section>

<section aria-labelledby="see-title">
  <div class="wrap">
    <div class="section-head">
      <p class="kicker">See it</p>
      <h2 id="see-title">Every agent in view, only the ones that need you in your face.</h2>
      <p>Screenshots of today's app, running two small demo projects.</p>
    </div>
    <div class="shots">
      <figure class="shot shot-wide">
        <a href="{{ '/assets/images/screenshots/eagle-view.png' | relative_url }}"><img src="{{ '/assets/images/screenshots/eagle-view.png' | relative_url }}" width="1750" height="1125" alt="Eagle view: six Claude Code terminals from two projects shown as tiles on one screen, each with its project name, branch and latest answer."></a>
        <figcaption><strong>Eagle view.</strong> Every terminal from every open project on one screen, with a red glow on the ones waiting for you.</figcaption>
      </figure>
      <figure class="shot">
        <a href="{{ '/assets/images/screenshots/terminals.png' | relative_url }}"><img src="{{ '/assets/images/screenshots/terminals.png' | relative_url }}" width="1750" height="1125" alt="Four Claude Code terminals of one project in a two by two grid, each showing the agent's last reply and a prompt." loading="lazy"></a>
        <figcaption><strong>One project, many agents.</strong> Each Claude Code session runs in its own terminal, side by side.</figcaption>
      </figure>
      <figure class="shot">
        <a href="{{ '/assets/images/screenshots/sessions-working.png' | relative_url }}"><img src="{{ '/assets/images/screenshots/sessions-working.png' | relative_url }}" width="1750" height="1125" alt="A second project open in its own tab, with two terminals showing the agents' work as it happens." loading="lazy"></a>
        <figcaption><strong>Projects as tabs.</strong> Each project keeps its own terminals, and hidden tabs keep running.</figcaption>
      </figure>
      <figure class="shot">
        <a href="{{ '/assets/images/screenshots/parked-shelf.png' | relative_url }}"><img src="{{ '/assets/images/screenshots/parked-shelf.png' | relative_url }}" width="1750" height="1125" alt="Four terminals on screen and a Parked strip at the bottom holding two parked terminals as pills." loading="lazy"></a>
        <figcaption><strong>Parking.</strong> Park the terminals that need nobody; they come back by themselves when they finish or ask you something.</figcaption>
      </figure>
      <figure class="shot">
        <a href="{{ '/assets/images/screenshots/work-journal.png' | relative_url }}"><img src="{{ '/assets/images/screenshots/work-journal.png' | relative_url }}" width="1750" height="1125" alt="The Work Journal panel beside the terminals: today's page with an entry card and two suggested entries to accept or reject." loading="lazy"></a>
        <figcaption><strong>Work Journal.</strong> One page per day, with entries suggested from the day's work for you to accept or reject.</figcaption>
      </figure>
      <figure class="shot shot-wide">
        <a href="{{ '/assets/images/screenshots/issue-map.png' | relative_url }}"><img src="{{ '/assets/images/screenshots/issue-map.png' | relative_url }}" width="1750" height="1100" alt="The issue map window: a project's GitHub issues in columns by level, with lines showing which issue blocks which." loading="lazy"></a>
        <figcaption><strong>Issue map.</strong> Your GitHub issues in their own window, level by level, so you see what blocks what.</figcaption>
      </figure>
    </div>
  </div>
</section>

<section class="features" aria-labelledby="features-title">
  <div class="wrap">
    <div class="section-head">
      <p class="kicker">What it does</p>
      <h2 id="features-title">Built for one developer supervising many agents.</h2>
      <p>Everything runs on your computer. Maestro talks only to the tools you already use: git, the GitHub CLI and the Claude CLI.</p>
    </div>
    <ul class="feature-grid">
      <li>
        <h3>All terminals, one screen</h3>
        <p>Projects open as tabs. Eagle view shows every project's terminals as tiles; zoom maximises one.</p>
      </li>
      <li>
        <h3>Know who needs you</h3>
        <p>Each terminal shows whether its agent is working, done or waiting, and the waiting ones glow red.</p>
      </li>
      <li>
        <h3>Park what needs nobody</h3>
        <p>Hide a terminal without stopping it. It comes back on its own when it finishes, fails or asks a question.</p>
      </li>
      <li>
        <h3>Talk to many at once</h3>
        <p>The Injector sends one message to every ticked terminal, and triggers send one when context fills up.</p>
      </li>
      <li>
        <h3>Git and GitHub beside you</h3>
        <p>A commit graph, branches and worktrees, pull requests and issues, and a map of what blocks what.</p>
      </li>
      <li>
        <h3>A journal that writes itself</h3>
        <p>The Work Journal suggests one line per project from your day, and turns weeks into a report.</p>
      </li>
    </ul>
    <p class="more"><a href="{% link features.md %}">See every feature →</a></p>
  </div>
</section>

<section aria-labelledby="install-title">
  <div class="wrap">
    <div class="section-head">
      <p class="kicker">Get started</p>
      <h2 id="install-title">Installed in a few minutes.</h2>
    </div>
    <ol class="steps">
      <li>
        <h3>Download</h3>
        <p>The <code>.msi</code> for Windows or the <code>.dmg</code> for macOS (Apple silicon and Intel) from the <a href="https://github.com/nachogl1/maestro/releases/latest">latest release</a>.</p>
      </li>
      <li>
        <h3>Install</h3>
        <p>Run the installer. On a Mac, the first launch needs one extra step, explained on the Installation page.</p>
      </li>
      <li>
        <h3>Add Claude Code</h3>
        <p>Maestro runs Claude Code sessions, so install Git and Claude Code too. Later updates arrive inside the app.</p>
      </li>
    </ol>
    <p class="more"><a href="{% link installation.md %}">Full installation steps, including Linux →</a></p>
  </div>
</section>
