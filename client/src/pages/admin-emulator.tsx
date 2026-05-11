import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth, logout } from "@/hooks/useAuth";
import { ArrowLeft, Bell, ShieldCheck, Users, Database, LogOut, Smartphone } from "lucide-react";

interface AuditEvent {
  id: string;
  timestamp: string;
  actorType: string | null;
  actorId: string | null;
  sessionId: string;
  ipTruncated: string;
  userAgentHash: string;
  actionCode: number;
  resourceType: string;
  resourceId: string;
  result: string;
  latencyMs: number | null;
  metadata: Record<string, any>;
}

interface EmulatorUser {
  id: string;
  username: string;
  email: string;
  password: string;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
  isSeller: boolean;
  credits: string;
  loyaltyLevel: string;
}

interface NotificationFormData {
  title: string;
  message: string;
  target: "all" | "selected";
  recipients: string;
  link: string;
  severity: "info" | "warning" | "critical";
}

interface PermissionsFormData {
  requestContacts: boolean;
  requestNotifications: boolean;
}

interface ActionLogFormData {
  label: string;
  description: string;
}

export default function AdminEmulatorPanel() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [contactsAccess, setContactsAccess] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<string>("default");

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setLocation("/admin-login");
    }
  }, [isLoading, isAuthenticated, setLocation]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const wsUrl = `ws://${window.location.host}`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'register_admin', clientType: 'admin' }));
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'new_installation' || data.type === 'ban_update' || data.type === 'notification' || data.type === 'contacts_update') {
          queryClient.invalidateQueries({ queryKey: ["/api/emulator/installations"] });
          queryClient.invalidateQueries({ queryKey: ["/api/emulator/notifications"] });
          queryClient.invalidateQueries({ queryKey: ["/api/audit/events", "emulator"] });
        }
      } catch (error) {
        console.error('Admin websocket error:', error);
      }
    };

    return () => {
      socket.close();
    };
  }, [isAuthenticated, queryClient]);

  const auditQuery = useQuery({
    queryKey: ["/api/audit/events", "emulator"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/audit/events?limit=40");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  const usersQuery = useQuery({
    queryKey: ["/api/emulator/users"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/emulator/users");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  const notificationsQuery = useQuery({
    queryKey: ["/api/emulator/notifications"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/emulator/notifications");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  const createNotificationMutation = useMutation({
    mutationFn: async (data: NotificationFormData) => {
      const payload = {
        title: data.title,
        message: data.message,
        target: data.target,
        recipients: data.target === "selected" ? data.recipients.split(",").map((item) => item.trim()).filter(Boolean) : [],
        link: data.link || undefined,
        severity: data.severity,
      };
      const res = await apiRequest("POST", "/api/emulator/notifications", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/emulator/notifications"] });
      toast({ title: "Notificación enviada", description: "La alerta de emulador se registró correctamente." });
    },
    onError: () => {
      toast({ title: "Error", description: "No se pudo enviar la notificación", variant: "destructive" });
    },
  });

  const updatePermissionsMutation = useMutation({
    mutationFn: async (data: PermissionsFormData) => {
      const res = await apiRequest("POST", "/api/emulator/permissions", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Permisos guardados", description: "Los permisos de emulador se han registrado." });
    },
    onError: () => {
      toast({ title: "Error", description: "No se pudieron actualizar los permisos", variant: "destructive" });
    },
  });

  const logActionMutation = useMutation({
    mutationFn: async (data: ActionLogFormData) => {
      const res = await apiRequest("POST", "/api/emulator/log-action", {
        label: data.label,
        description: data.description,
        source: "admin-emulator",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/audit/events", "emulator"] });
      toast({ title: "Acción registrada", description: "El evento de emulador se ha guardado en auditoría." });
    },
    onError: () => {
      toast({ title: "Error", description: "No se pudo registrar la acción", variant: "destructive" });
    },
  });
  const installationsQuery = useQuery({
    queryKey: ["/api/emulator/installations"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/emulator/installations");
      return res.json();
    },
    enabled: isAuthenticated,
  });
  const createUserMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/auth/register", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/emulator/users"] });
      toast({ title: "Usuario creado", description: "La cuenta se creó correctamente." });
    },
    onError: () => {
      toast({ title: "Error", description: "No se pudo crear la cuenta", variant: "destructive" });
    },
  });

  const notificationForm = useForm<NotificationFormData>({
    resolver: zodResolver(z.object({
      title: z.string().min(1),
      message: z.string().min(1),
      target: z.enum(["all", "selected"]),
      recipients: z.string().optional(),
      link: z.string().url().optional(),
      severity: z.enum(["info", "warning", "critical"]),
    })) ,
    defaultValues: {
      title: "Nueva versión disponible",
      message: "Hay una actualización lista para desplegar. Toca el enlace para ver los detalles.",
      target: "all",
      recipients: "",
      link: "https://example.com/update",
      severity: "info",
    }
  });

  const permissionsForm = useForm<PermissionsFormData>({
    defaultValues: {
      requestContacts: false,
      requestNotifications: false,
    }
  });

  const actionForm = useForm<ActionLogFormData>({
    defaultValues: {
      label: "Botón de actualización",
      description: "Usuario emulador activó la alerta de nueva versión.",
    }
  });

  const accountForm = useForm({
    defaultValues: {
      username: "",
      email: "",
      password: "",
      firstName: "",
      lastName: "",
      phone: "",
    }
  });

  const auditEvents = auditQuery.data?.data || [];
  const emulatorUsers = usersQuery.data?.users || [];
  const notifications = notificationsQuery.data?.notifications || [];

  const canRequestNotifications = typeof Notification !== "undefined";

  const handleRequestNotifications = async () => {
    if (!canRequestNotifications) {
      toast({ title: "No soportado", description: "Las notificaciones no están disponibles en este navegador.", variant: "destructive" });
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    toast({ title: "Permiso de notificaciones", description: `Estado: ${permission}` });
  };

  const handleSubmitPermissions = (data: PermissionsFormData) => {
    setContactsAccess(data.requestContacts);
    updatePermissionsMutation.mutate(data);
  };

  const handleActionSubmit = (data: ActionLogFormData) => {
    logActionMutation.mutate(data);
  };

  const handleCreateAccount = (data: any) => {
    createUserMutation.mutate(data);
  };

  const handlePermissionToggle = async (userId: string, key: "isAdmin" | "isSeller", value: boolean) => {
    try {
      await apiRequest("PATCH", `/api/emulator/users/${userId}/permissions`, { [key]: value });
      queryClient.invalidateQueries({ queryKey: ["/api/emulator/users"] });
      toast({ title: "Permiso actualizado", description: "El permiso de usuario se actualizó." });
    } catch {
      toast({ title: "Error", description: "No se pudo actualizar el permiso", variant: "destructive" });
    }
  };

  const latestButtonAction = useMemo(() => {
    return auditEvents.find((event: AuditEvent) => event.resourceType === 'emulator_action');
  }, [auditEvents]);

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card>
          <CardContent>
            <p className="text-center">Redirigiendo al login de administrador...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground py-6 px-4">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Panel Emulador de Auditoría</h1>
            <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
              Acceso directo para revisar credenciales, actividad, permisos y notificaciones de la aplicación.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setLocation('/admin') }>
              <ArrowLeft className="mr-2 h-4 w-4" /> Volver al admin normal
            </Button>
            <Button variant="outline" size="sm" onClick={() => logout()}>
              <LogOut className="mr-2 h-4 w-4" /> Cerrar sesión
            </Button>
          </div>
        </div>

        <Tabs defaultValue="activity" className="space-y-4">
          <TabsList>
            <TabsTrigger value="activity"><Database className="mr-2 h-4 w-4" />Actividad</TabsTrigger>
            <TabsTrigger value="users"><Users className="mr-2 h-4 w-4" />Usuarios</TabsTrigger>
            <TabsTrigger value="notifications"><Bell className="mr-2 h-4 w-4" />Notificaciones</TabsTrigger>
            <TabsTrigger value="permissions"><ShieldCheck className="mr-2 h-4 w-4" />Permisos</TabsTrigger>
            <TabsTrigger value="installations"><Smartphone className="mr-2 h-4 w-4" />Instalaciones</TabsTrigger>
          </TabsList>

          <TabsContent value="activity">
            <Card>
              <CardHeader>
                <CardTitle>Registro de Auditoría</CardTitle>
                <CardDescription>Muestra IP truncada, usuario, evento y meta datos.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {auditQuery.isLoading ? (
                  <p>Cargando actividad...</p>
                ) : auditEvents.length === 0 ? (
                  <p>No hay eventos de auditoría en este momento.</p>
                ) : (
                  <div className="space-y-3">
                    {auditEvents.map((event: AuditEvent) => (
                      <div key={event.id} className="rounded-lg border border-border p-4 bg-muted/70">
                        <div className="flex flex-col sm:flex-row sm:justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold">{event.resourceType} · {event.result}</p>
                            <p className="text-xs text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</p>
                          </div>
                          <div className="text-right text-xs text-muted-foreground">
                            <p>{event.ipTruncated}</p>
                            <p>{event.sessionId}</p>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <p><span className="font-semibold">Actor:</span> {event.actorType ?? 'anonimo'} / {event.actorId ?? 'desconocido'}</p>
                          <p><span className="font-semibold">Recurso:</span> {event.resourceId}</p>
                        </div>
                        <div className="mt-3 overflow-x-auto text-xs text-muted-foreground">
                          <pre className="whitespace-pre-wrap break-words">{JSON.stringify(event.metadata, null, 2)}</pre>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Evento más reciente de emulador</CardTitle>
                <CardDescription>Botones y acciones que han generado auditoría.</CardDescription>
              </CardHeader>
              <CardContent>
                {latestButtonAction ? (
                  <div className="space-y-2">
                    <p><span className="font-semibold">Etiqueta:</span> {latestButtonAction.metadata.label}</p>
                    <p><span className="font-semibold">Fuente:</span> {latestButtonAction.metadata.source}</p>
                    <p><span className="font-semibold">Descripción:</span> {latestButtonAction.metadata.description}</p>
                  </div>
                ) : (
                  <p>No hay acciones de emulador registradas.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="users">
            <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
              <Card>
                <CardHeader>
                  <CardTitle>Usuarios existentes</CardTitle>
                  <CardDescription>Credenciales, permisos y estado de cada cuenta.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {usersQuery.isLoading ? (
                    <p>Cargando usuarios...</p>
                  ) : emulatorUsers.length === 0 ? (
                    <p>No se encontraron usuarios.</p>
                  ) : (
                    <div className="space-y-3">
                      {emulatorUsers.map((user: EmulatorUser) => (
                        <div key={user.id} className="rounded-lg border border-border p-4 bg-muted/70">
                          <div className="flex flex-col gap-1 sm:flex-row sm:justify-between">
                            <div>
                              <p className="font-semibold">{user.username}</p>
                              <p className="text-xs text-muted-foreground">{user.email}</p>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>Admin: {user.isAdmin ? 'Sí' : 'No'}</span>
                              <span>Seller: {user.isSeller ? 'Sí' : 'No'}</span>
                            </div>
                          </div>
                          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <p><span className="font-semibold">Nombre:</span> {user.firstName} {user.lastName}</p>
                            <p><span className="font-semibold">Contraseña:</span> {user.password}</p>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button size="sm" variant={user.isAdmin ? "secondary" : "outline"} onClick={() => handlePermissionToggle(user.id, "isAdmin", !user.isAdmin)}>
                              {user.isAdmin ? "Revocar admin" : "Otorgar admin"}
                            </Button>
                            <Button size="sm" variant={user.isSeller ? "secondary" : "outline"} onClick={() => handlePermissionToggle(user.id, "isSeller", !user.isSeller)}>
                              {user.isSeller ? "Revocar seller" : "Otorgar seller"}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Crear cuenta de emulador</CardTitle>
                  <CardDescription>Genera nuevas credenciales directamente desde el panel.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Form {...accountForm}>
                    <form onSubmit={accountForm.handleSubmit(handleCreateAccount)} className="space-y-4">
                      <FormField control={accountForm.control} name="username" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Usuario</FormLabel>
                          <FormControl><Input {...field} /></FormControl>
                        </FormItem>
                      )} />
                      <FormField control={accountForm.control} name="email" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email</FormLabel>
                          <FormControl><Input type="email" {...field} /></FormControl>
                        </FormItem>
                      )} />
                      <FormField control={accountForm.control} name="password" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Contraseña</FormLabel>
                          <FormControl><Input type="password" {...field} /></FormControl>
                        </FormItem>
                      )} />
                      <FormField control={accountForm.control} name="firstName" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Nombre</FormLabel>
                          <FormControl><Input {...field} /></FormControl>
                        </FormItem>
                      )} />
                      <FormField control={accountForm.control} name="lastName" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Apellido</FormLabel>
                          <FormControl><Input {...field} /></FormControl>
                        </FormItem>
                      )} />
                      <Button type="submit" className="w-full">Crear cuenta</Button>
                    </form>
                  </Form>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="notifications">
            <Card>
              <CardHeader>
                <CardTitle>Enviar alerta</CardTitle>
                <CardDescription>Activa alertas de actualización para todos o usuarios seleccionados.</CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...notificationForm}>
                  <form onSubmit={notificationForm.handleSubmit((values) => createNotificationMutation.mutate(values))} className="space-y-4">
                    <FormField control={notificationForm.control} name="title" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Título</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                      </FormItem>
                    )} />
                    <FormField control={notificationForm.control} name="message" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mensaje</FormLabel>
                        <FormControl><Textarea {...field} rows={4} /></FormControl>
                      </FormItem>
                    )} />
                    <FormField control={notificationForm.control} name="link" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Link directo</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <p className="text-xs text-muted-foreground">URL para la actualización o recurso señalado.</p>
                      </FormItem>
                    )} />
                    <FormField control={notificationForm.control} name="target" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Destino</FormLabel>
                        <FormControl>
                          <select {...field} className="w-full rounded-md border p-2 bg-background text-foreground">
                            <option value="all">Todos los usuarios</option>
                            <option value="selected">Usuarios específicos</option>
                          </select>
                        </FormControl>
                      </FormItem>
                    )} />
                    {notificationForm.watch("target") === "selected" ? (
                      <FormField control={notificationForm.control} name="recipients" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Usuarios (separados por coma)</FormLabel>
                          <FormControl><Input {...field} /></FormControl>
                        </FormItem>
                      )} />
                    ) : null}
                    <FormField control={notificationForm.control} name="severity" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Severidad</FormLabel>
                        <FormControl>
                          <select {...field} className="w-full rounded-md border p-2 bg-background text-foreground">
                            <option value="info">Info</option>
                            <option value="warning">Advertencia</option>
                            <option value="critical">Crítica</option>
                          </select>
                        </FormControl>
                      </FormItem>
                    )} />
                    <Button type="submit" className="w-full">Enviar alerta</Button>
                  </form>
                </Form>
              </CardContent>
            </Card>

            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Historial de alertas</CardTitle>
                <CardDescription>Mensajes enviados desde el panel de emulador.</CardDescription>
              </CardHeader>
              <CardContent>
                {notificationsQuery.isLoading ? (
                  <p>Cargando alertas...</p>
                ) : notifications.length === 0 ? (
                  <p>No hay alertas enviadas aún.</p>
                ) : (
                  <div className="space-y-3">
                    {notifications.map((notification: any) => (
                      <div key={notification.id} className="rounded-lg border border-border p-4 bg-muted/70">
                        <p className="font-semibold">{notification.metadata?.title || "Alerta"}</p>
                        <p className="text-xs text-muted-foreground">{new Date(notification.timestamp).toLocaleString()}</p>
                        <p className="mt-2">{notification.metadata?.message}</p>
                        {notification.metadata?.link ? (
                          <a href={notification.metadata.link} target="_blank" rel="noreferrer" className="text-primary underline">{notification.metadata.link}</a>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="permissions">
            <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
              <Card>
                <CardHeader>
                  <CardTitle>Permisos de emulador</CardTitle>
                  <CardDescription>Solicita permisos y registra ese estado en auditoría.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Form {...permissionsForm}>
                    <form onSubmit={permissionsForm.handleSubmit(handleSubmitPermissions)} className="space-y-4">
                      <div className="flex items-center justify-between gap-3 rounded-lg border p-4">
                        <div>
                          <p className="font-semibold">Acceso a contactos</p>
                          <p className="text-xs text-muted-foreground">Permiso simulado para experiencia de emulador.</p>
                        </div>
                        <Switch checked={contactsAccess} onCheckedChange={setContactsAccess} />
                      </div>

                      <div className="flex items-center justify-between gap-3 rounded-lg border p-4">
                        <div>
                          <p className="font-semibold">Notificaciones</p>
                          <p className="text-xs text-muted-foreground">Permiso real de notificaciones web.</p>
                        </div>
                        <Button type="button" variant="outline" onClick={handleRequestNotifications}>
                          Solicitar permiso
                        </Button>
                      </div>

                      <Button type="submit" className="w-full">Guardar estado de permisos</Button>
                    </form>
                  </Form>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Registrar acción específica</CardTitle>
                  <CardDescription>Genera un evento con hora, origen y descripción.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Form {...actionForm}>
                    <form onSubmit={actionForm.handleSubmit(handleActionSubmit)} className="space-y-4">
                      <FormField control={actionForm.control} name="label" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Etiqueta</FormLabel>
                          <FormControl><Input {...field} /></FormControl>
                        </FormItem>
                      )} />
                      <FormField control={actionForm.control} name="description" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Descripción</FormLabel>
                          <FormControl><Textarea {...field} rows={3} /></FormControl>
                        </FormItem>
                      )} />
                      <Button type="submit" className="w-full">Registrar acción</Button>
                    </form>
                  </Form>
                </CardContent>
              </Card>
            </div>

            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Estado de permisos</CardTitle>
              </CardHeader>
              <CardContent>
                <p>Contactos: {contactsAccess ? 'Activo' : 'Inactivo'}</p>
                <p>Notificaciones: {notificationPermission}</p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="installations">
            <Card>
              <CardHeader>
                <CardTitle>Instalaciones de App Móvil</CardTitle>
                <CardDescription>
                  Gestiona las instalaciones de la aplicación móvil, permisos y baneos.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {installationsQuery.isLoading ? (
                  <p>Cargando instalaciones...</p>
                ) : installationsQuery.data?.installations ? (
                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-lg font-semibold">
                        Total de Instalaciones: {installationsQuery.data.total}
                      </h3>
                    </div>
                    <div className="grid gap-4">
                      {installationsQuery.data.installations.map((installation: any) => (
                        <Card key={installation.id}>
                          <CardContent className="pt-4">
                            <div className="flex justify-between items-start">
                              <div>
                                <p><strong>Device ID:</strong> {installation.deviceId}</p>
                                <p><strong>Usuario:</strong> {installation.username || 'No logueado'}</p>
                                <p><strong>IP:</strong> {installation.ipAddress}</p>
                                <p><strong>Versión:</strong> {installation.version}</p>
                                <p><strong>Permisos de Contactos:</strong> {installation.contactsPermission ? 'Sí' : 'No'}</p>
                                <p><strong>Instalado:</strong> {new Date(installation.installedAt).toLocaleString()}</p>
                                <p><strong>Última Actividad:</strong> {new Date(installation.lastActivity).toLocaleString()}</p>
                                {installation.isBanned && (
                                  <p className="text-red-600"><strong>BANEADO:</strong> {installation.banReason}</p>
                                )}
                                {installation.contactsPermission && installation.contactsData && (
                                  <div className="mt-3 rounded-lg border border-border bg-muted/80 p-3">
                                    <p className="font-semibold">Contactos importados:</p>
                                    <div className="mt-2 max-h-40 overflow-y-auto text-xs text-muted-foreground">
                                      {Array.isArray(installation.contactsData) ? (
                                        installation.contactsData.slice(0, 20).map((contact: any, index: number) => (
                                          <div key={index} className="mb-2">
                                            <p className="font-medium">{contact.displayName || contact.name || 'Contacto sin nombre'}</p>
                                            {contact.phoneNumbers?.map((phone: any, idx: number) => (
                                              <p key={idx}>📞 {phone.number}</p>
                                            ))}
                                            {contact.emails?.map((email: any, idx: number) => (
                                              <p key={idx}>✉️ {email.address}</p>
                                            ))}
                                          </div>
                                        ))
                                      ) : (
                                        <pre className="whitespace-pre-wrap">{JSON.stringify(installation.contactsData, null, 2)}</pre>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                              <div className="flex gap-2">
                                <Button
                                  variant={installation.isBanned ? "default" : "destructive"}
                                  size="sm"
                                  onClick={() => {
                                    const reason = installation.isBanned ? '' : prompt('Razón del baneo:');
                                    if (reason !== null) {
                                      apiRequest("PATCH", `/api/emulator/installations/${installation.deviceId}/ban`, {
                                        banned: !installation.isBanned,
                                        reason
                                      }).then(() => {
                                        queryClient.invalidateQueries({ queryKey: ["/api/emulator/installations"] });
                                        toast({ title: installation.isBanned ? "Desbaneado" : "Baneado", description: `Dispositivo ${installation.isBanned ? "desbaneado" : "baneado"} correctamente.` });
                                      });
                                    }
                                  }}
                                >
                                  {installation.isBanned ? "Desbanear" : "Banear"}
                                </Button>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p>No hay instalaciones registradas.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
