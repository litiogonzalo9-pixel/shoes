import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import { ArrowLeft, LogIn, UserPlus } from "lucide-react";
import { setAuthUser } from "@/hooks/useAuth";

// Esquemas de validación
const loginSchema = z.object({
  username: z.string().min(1, "El usuario es requerido"),
  password: z.string().min(1, "La contraseña es requerida"),
});

const registerSchema = z.object({
  username: z.string().min(3, "El usuario debe tener al menos 3 caracteres"),
  email: z.string().email("Email inválido"),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
  firstName: z.string().min(1, "El nombre es requerido"),
  lastName: z.string().min(1, "El apellido es requerido"),
  phone: z.string().optional(),
});

type LoginFormData = z.infer<typeof loginSchema>;
type RegisterFormData = z.infer<typeof registerSchema>;

interface LoginPageProps {
  isAdmin?: boolean;
  onSuccess?: (user: any) => void;
}

export default function LoginPage({ isAdmin = false, onSuccess }: LoginPageProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);

  const loginForm = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: "",
      password: "",
    },
  });

  const registerForm = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      username: "",
      email: "",
      password: "",
      firstName: "",
      lastName: "",
      phone: "",
    },
  });

  const handleLogin = async (data: LoginFormData) => {
    setIsLoading(true);
    try {
      const response = await apiRequest("POST", "/api/auth/login", {
        ...data,
        isAdmin,
      });
      
      const responseData = await response.json();
      
      toast({
        title: "¡Bienvenido!",
        description: `Sesión iniciada como ${isAdmin ? 'administrador' : 'usuario'}`,
      });
      
      // Guardar usuario en el estado de autenticación
      setAuthUser(responseData.user);
      
      if (onSuccess) {
        onSuccess(responseData);
      } else {
        if (responseData.user?.isEmulator) {
          window.location.href = '/admin-emulator';
        } else {
          window.location.href = isAdmin ? '/admin' : '/';
        }
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Usuario o contraseña incorrectos",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (data: RegisterFormData) => {
    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/auth/register", data);
      
      toast({
        title: "¡Cuenta creada!",
        description: "Ahora puedes iniciar sesión con tu nueva cuenta",
      });
      
      // Cambiar automáticamente a la pestaña de login
      registerForm.reset();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Error al crear la cuenta",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header con botón de regreso */}
        <div className="flex items-center mb-6">
          <Link href="/">
            <Button variant="ghost" size="sm" data-testid="button-back-home">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Volver a ZapaShop
            </Button>
          </Link>
        </div>

        <Card className="shadow-lg">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold">
              👟 ZapaShop {isAdmin && "Admin"}
            </CardTitle>
            <CardDescription>
              {isAdmin 
                ? "Panel de administración - Solo para administradores"
                : "Inicia sesión o crea tu cuenta para obtener créditos y promociones especiales"
              }
            </CardDescription>
          </CardHeader>
          
          <CardContent>
            {!isAdmin ? (
              <Tabs defaultValue="login" className="space-y-4">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="login" data-testid="tab-login">
                    <LogIn className="w-4 h-4 mr-2" />
                    Iniciar Sesión
                  </TabsTrigger>
                  <TabsTrigger value="register" data-testid="tab-register">
                    <UserPlus className="w-4 h-4 mr-2" />
                    Registrarse
                  </TabsTrigger>
                </TabsList>

                {/* Pestaña de Login */}
                <TabsContent value="login">
                  <Form {...loginForm}>
                    <form onSubmit={loginForm.handleSubmit(handleLogin)} className="space-y-4">
                      <FormField
                        control={loginForm.control}
                        name="username"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Usuario</FormLabel>
                            <FormControl>
                              <Input {...field} data-testid="input-login-username" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      
                      <FormField
                        control={loginForm.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Contraseña</FormLabel>
                            <FormControl>
                              <Input type="password" {...field} data-testid="input-login-password" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      
                      <Button 
                        type="submit" 
                        className="w-full" 
                        disabled={isLoading}
                        data-testid="button-submit-login"
                      >
                        {isLoading ? "Iniciando..." : "Iniciar Sesión"}
                      </Button>
                    </form>
                  </Form>
                </TabsContent>

                {/* Pestaña de Registro */}
                <TabsContent value="register">
                  <Form {...registerForm}>
                    <form onSubmit={registerForm.handleSubmit(handleRegister)} className="space-y-4">
                      <div className="grid grid-cols-2 gap-2">
                        <FormField
                          control={registerForm.control}
                          name="firstName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Nombre</FormLabel>
                              <FormControl>
                                <Input {...field} data-testid="input-register-firstname" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        
                        <FormField
                          control={registerForm.control}
                          name="lastName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Apellido</FormLabel>
                              <FormControl>
                                <Input {...field} data-testid="input-register-lastname" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      
                      <FormField
                        control={registerForm.control}
                        name="username"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Usuario</FormLabel>
                            <FormControl>
                              <Input {...field} data-testid="input-register-username" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      
                      <FormField
                        control={registerForm.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Email</FormLabel>
                            <FormControl>
                              <Input type="email" {...field} data-testid="input-register-email" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      
                      <FormField
                        control={registerForm.control}
                        name="phone"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Teléfono (opcional)</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value || ""} data-testid="input-register-phone" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      
                      <FormField
                        control={registerForm.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Contraseña</FormLabel>
                            <FormControl>
                              <Input type="password" {...field} data-testid="input-register-password" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      
                      <Button 
                        type="submit" 
                        className="w-full" 
                        disabled={isLoading}
                        data-testid="button-submit-register"
                      >
                        {isLoading ? "Creando cuenta..." : "Crear Cuenta"}
                      </Button>
                    </form>
                  </Form>
                  
                  <div className="mt-4 p-3 bg-accent/10 rounded-lg">
                    <h4 className="font-semibold text-sm mb-2">🎁 Beneficios de registrarse:</h4>
                    <ul className="text-xs text-muted-foreground space-y-1">
                      <li>• Gana créditos con cada compra</li>
                      <li>• Promociones exclusivas para miembros</li>
                      <li>• Programa de lealtad con niveles</li>
                      <li>• Descuentos especiales por compras frecuentes</li>
                    </ul>
                  </div>
                </TabsContent>
              </Tabs>
            ) : (
              // Panel de login solo para administradores
              <div className="space-y-4">
                <div className="text-center p-4 bg-destructive/10 rounded-lg">
                  <p className="text-sm text-destructive font-medium">
                    🔒 Acceso restringido solo para administradores
                  </p>
                </div>
                
                {/* Credenciales de prueba */}
                
                <Form {...loginForm}>
                  <form onSubmit={loginForm.handleSubmit(handleLogin)} className="space-y-4">
                    <FormField
                      control={loginForm.control}
                      name="username"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Usuario Administrador</FormLabel>
                          <FormControl>
                            <Input {...field} data-testid="input-admin-username" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    
                    <FormField
                      control={loginForm.control}
                      name="password"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Contraseña</FormLabel>
                          <FormControl>
                            <Input type="password" {...field} data-testid="input-admin-password" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    
                    <Button 
                      type="submit" 
                      className="w-full" 
                      disabled={isLoading}
                      data-testid="button-submit-admin-login"
                    >
                      {isLoading ? "Verificando..." : "Acceder al Panel"}
                    </Button>
                  </form>
                </Form>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}