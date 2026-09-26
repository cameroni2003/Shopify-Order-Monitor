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
    status: "STALE",
    url: new URL(request.url),
    basePath: "/app/stale",
  });
};

export default function StalePage() {
  const data = useLoaderData<typeof loader>();
  return <OrderListView heading="Stale (60+ days)" data={data} basePath="/app/stale" />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
