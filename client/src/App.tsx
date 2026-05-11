import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useMobileApp } from "./hooks/useMobileApp";
import Home from "@/pages/home";
import SellerDashboard from "@/pages/seller-dashboard";
import AdminPanel from "@/pages/admin";
import AdminEmulatorPanel from "@/pages/admin-emulator";
import LoginPage from "@/pages/login";
import CheckoutPage from "@/pages/checkout";
import ProductDetails from "@/pages/product-details";
import OrderTracking from "@/pages/order-tracking";
import NotFound from "@/pages/not-found";

function AppRouter() {
  const { isNative, isBanned } = useMobileApp();

  // If banned, show ban message
  if (isBanned) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-red-50">
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Aplicación Bloqueada</h1>
          <p className="text-gray-600">Esta aplicación ha sido bloqueada por el administrador.</p>
          <p className="text-sm text-gray-500 mt-2">Por favor, contacte al soporte.</p>
        </div>
      </div>
    );
  }

  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/seller" component={SellerDashboard} />
      <Route path="/admin" component={AdminPanel} />
      <Route path="/admin-emulator" component={AdminEmulatorPanel} />
      <Route path="/checkout" component={CheckoutPage} />
      <Route path="/product/:id" component={ProductDetails} />
      <Route path="/seguimiento" component={OrderTracking} />
      <Route path="/admin-login" component={() => <LoginPage isAdmin={true} />} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppRouter />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
