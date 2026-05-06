import Link from "next/link";
import { DocsBody, DocsPage } from "fumadocs-ui/page";

export function DocsMissingPage() {
  return (
    <DocsPage
      toc={[]}
      tableOfContent={{
        enabled: false,
      }}
      breadcrumb={{
        enabled: true,
        includePage: false,
      }}
      footer={{
        enabled: false,
      }}
    >
      <DocsBody>
        <div className="not-prose docs-missing-wrap">
          <div className="docs-missing-card">
            <div className="docs-missing-label">
              docs / checkout failed
            </div>
            <div className="docs-missing-content">
              <section className="docs-missing-copy">
                <h2>
                  This page checked out the wrong worktree.
                </h2>
                <p>
                  The docs were rebuilt, and this URL did not survive the merge. Start from the docs
                  index, or use search in the sidebar to find where it landed.
                </p>
                <div className="docs-missing-actions">
                  <Link
                    href="/docs"
                    className="docs-missing-primary"
                  >
                    Browse docs
                  </Link>
                  <Link
                    href="/"
                    className="docs-missing-secondary"
                  >
                    Home
                  </Link>
                </div>
              </section>
              <div className="docs-missing-terminal">
                <div className="docs-missing-dots">
                  <span className="docs-missing-dot-red" />
                  <span className="docs-missing-dot-yellow" />
                  <span className="docs-missing-dot-green" />
                </div>
                <p className="docs-missing-command">$ ao docs resolve</p>
                <p className="docs-missing-status">status: missing</p>
                <p>next: /docs</p>
              </div>
            </div>
          </div>
        </div>
      </DocsBody>
    </DocsPage>
  );
}
