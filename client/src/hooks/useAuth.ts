import { useState, useEffect } from "react";

interface User {
  id: string;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
  isSeller: boolean;
  credits: string;
  loyaltyLevel: string;
  isEmulator?: boolean;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check if there's a stored user session
    const storedUser = localStorage.getItem('zapashop_user');
    if (storedUser) {
      try {
        const userData = JSON.parse(storedUser);
        setUser(userData);
      } catch (error) {
        localStorage.removeItem('zapashop_user');
      }
    }
    setIsLoading(false);
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
  };
}

export function setAuthUser(user: User | null) {
  if (user) {
    localStorage.setItem('zapashop_user', JSON.stringify(user));
  } else {
    localStorage.removeItem('zapashop_user');
  }
  // Trigger a page reload to update all components
  window.location.reload();
}

export function logout() {
  setAuthUser(null);
}