import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadOrderListPage } from "../lib/order-list.server";
import { OrderListView } from "../components/OrderListView";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return loadOrderListPage({
    shopDomain: session.shop,
    status: "NEEDS_ATTENTION",
    url: new URL(request.url),
    basePath: "/app",
  });
};

export default function NeedsAttentionPage() {
  const data = useLoaderData<typeof loader>();
  return <OrderListView heading="Needs attention" data={data} basePath="/app" />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
