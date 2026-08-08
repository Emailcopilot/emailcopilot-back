import { Router } from "express";
import * as userService from "../services/user.service";

export const usersRouter: Router = Router();

// ─── Users ─────────────────────────────────────────────
// GET    /users
// GET    /users/:id
// POST   /users
// POST   /users/webhook
// PUT    /users/:id
// DELETE /users/:id

usersRouter.get("/", userService.listUsers);

usersRouter.get("/:id", userService.getUser);

usersRouter.post("/webhook", userService.createUserWebhook);

usersRouter.post("/", userService.createUser);

usersRouter.put("/:id", userService.updateUser);

usersRouter.delete("/:id", userService.deleteUser);
