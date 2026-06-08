import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ReviewsAliasRoute(props: {
  searchParams: Promise<{ project?: string }>;
}) {
  const searchParams = await props.searchParams;
  const suffix = searchParams.project ? `?project=${encodeURIComponent(searchParams.project)}` : "";
  redirect(`/review${suffix}`);
}
