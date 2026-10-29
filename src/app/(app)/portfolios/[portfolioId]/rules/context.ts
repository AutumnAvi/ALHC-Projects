import "server-only";
import {
  getPortfolio,
  getWorkWeek,
  listEditablePortfolios,
  listPortfolioFields,
  listPortfolioMembers,
  listPortfolioProjects,
  listProfiles,
} from "@/lib/data";
import type { PortfolioRuleContext } from "@/lib/portfolio-rules";

// What the portfolio rule builder names: the portfolio's fields, people, members (rule owners), other
// portfolios the viewer edits, and the portfolio's projects the viewer can open (manual runs). Read
// with the viewer's own client.
export async function loadPortfolioRuleContext(portfolioId: string): Promise<PortfolioRuleContext> {
  const [portfolio, fields, profiles, members, others, projects, workWeek] = await Promise.all([
    getPortfolio(portfolioId),
    listPortfolioFields(portfolioId),
    listProfiles(),
    listPortfolioMembers(portfolioId),
    listEditablePortfolios(portfolioId),
    listPortfolioProjects(portfolioId),
    getWorkWeek(),
  ]);
  return {
    portfolioName: portfolio?.name ?? "",
    fields: fields.map((f) => ({
      id: f.id,
      name: f.name,
      fieldType: f.fieldType,
      options: f.options.map((o) => ({ id: o.id, name: o.name, color: o.color })),
      numberPrefix: f.numberPrefix ?? null,
    })),
    people: profiles.map((p) => ({ id: p.id, name: p.full_name || p.email })),
    members: members.map((m) => ({ id: m.profileId, name: m.fullName || m.email })),
    otherPortfolios: others,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    workWeek,
  };
}
