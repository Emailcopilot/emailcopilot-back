import { Router } from "express";
import * as userService from "../services/user.service";

export const usersRouter: Router = Router();

usersRouter.post("/webhook", userService.createUserWebhook);